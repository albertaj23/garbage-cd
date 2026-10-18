#include "event_buffer.hpp"

#include <algorithm>
#include <limits>
#include <utility>

#include "json_writer.hpp"

FileSink::FileSink(const std::string& path) : output_(std::fopen(path.c_str(), "wb")) {
    if (output_ == nullptr) {
        error_ = "unable to open trace output: " + path;
    }
}

FileSink::~FileSink() {
    if (output_ != nullptr) {
        std::fclose(output_);
    }
}

bool FileSink::writeLine(const std::string& line) {
    if (!error_.empty() || output_ == nullptr) {
        return false;
    }
    std::string lineWithNewline = line + '\n';
    const std::size_t written =
        std::fwrite(lineWithNewline.data(), 1, lineWithNewline.size(), output_);
    if (written != lineWithNewline.size() || std::fflush(output_) != 0) {
        error_ = "unable to write trace output";
        return false;
    }
    return true;
}

const std::string& FileSink::error() const {
    return error_;
}

bool MemorySink::writeLine(const std::string& line) {
    lines_.push_back(line);
    return true;
}

const std::string& MemorySink::error() const {
    return error_;
}

const std::vector<std::string>& MemorySink::lines() const {
    return lines_;
}

EventBuffer::EventBuffer(EventSink& sink, std::string runId, std::size_t batchCapacity,
                         TraceLevel level, std::uint64_t maxEvents, std::uint64_t maxBytes)
    : sink_(sink), runId_(std::move(runId)),
      batchCapacity_(std::max<std::size_t>(batchCapacity, 1)), level_(level),
      maxEvents_(maxEvents), maxBytes_(maxBytes) {}

void EventBuffer::statementBegin(std::uint32_t statementIndex) {
    enqueue(TraceEvent{Kind::StatementBegin, statementIndex});
}

void EventBuffer::statementEnd(std::uint32_t statementIndex) {
    enqueue(TraceEvent{Kind::StatementEnd, statementIndex});
}

void EventBuffer::allocation(std::uint32_t statementIndex, gc::ObjectHandle handle) {
    enqueue(TraceEvent{Kind::Allocate, statementIndex, handle.raw()});
}

void EventBuffer::rootSet(std::uint32_t statementIndex, const std::string& name,
                          gc::ObjectHandle handle) {
    TraceEvent event{Kind::RootSet, statementIndex, handle.raw()};
    event.nameId = intern(name);
    enqueue(event);
}

void EventBuffer::rootClear(std::uint32_t statementIndex, const std::string& name,
                            gc::ObjectHandle handle) {
    TraceEvent event{Kind::RootClear, statementIndex, handle.raw()};
    event.nameId = intern(name);
    enqueue(event);
}

void EventBuffer::fieldWrite(std::uint32_t statementIndex, const std::string& name,
                             gc::ObjectHandle object, gc::ObjectHandle target,
                             gc::ObjectHandle oldTarget) {
    TraceEvent event{Kind::FieldWrite, statementIndex, object.raw(), target.raw(),
                     oldTarget.raw()};
    event.nameId = intern(name);
    enqueue(event);
}

void EventBuffer::collectionBegin(std::uint32_t statementIndex, std::uint64_t gcIndex) {
    enqueue(TraceEvent{Kind::GcBegin, statementIndex, gcIndex});
}

void EventBuffer::collectionEnd(std::uint32_t statementIndex,
                                const memory::CollectionRecord& record) {
    enqueue(TraceEvent{Kind::GcEnd, statementIndex, record.gcIndex,
                       record.freed, record.liveAfter});
    flush();
}

void EventBuffer::markVisit(std::uint32_t statementIndex, gc::ObjectHandle child,
                            const memory::MarkDiscovery& discovery) {
    TraceEvent event{Kind::MarkVisit, statementIndex, child.raw()};
    if (discovery.parent) {
        event.hasParent = true;
        event.b = discovery.parent->raw();
    }
    if (discovery.root) {
        event.hasRoot = true;
        event.nameId = intern(*discovery.root);
    }
    enqueue(event);
}

void EventBuffer::sweepFree(std::uint32_t statementIndex, gc::ObjectHandle handle) {
    enqueue(TraceEvent{Kind::SweepFree, statementIndex, handle.raw()});
}

void EventBuffer::flush() {
    if (events_.empty() || !error_.empty()) {
        return;
    }

    std::string line = serializeBatch();
    if (bytesWritten_ + line.size() + 1 > maxBytes_) {
        std::vector<TraceEvent> structural;
        structural.reserve(events_.size());
        for (const TraceEvent& event : events_) {
            if (isStructural(event.kind)) {
                structural.push_back(event);
            } else {
                drop(event.kind);
                --retainedEvents_;
            }
        }
        events_.swap(structural);
        if (events_.empty()) {
            return;
        }
        for (auto it = pendingStrings_.begin(); it != pendingStrings_.end();) {
            const bool used = std::any_of(events_.begin(), events_.end(),
                [id = it->first](const TraceEvent& event) {
                    return (event.kind == Kind::RootSet || event.kind == Kind::RootClear ||
                            event.kind == Kind::FieldWrite ||
                            (event.kind == Kind::MarkVisit && event.hasRoot)) &&
                           event.nameId == id;
                });
            if (!used) {
                it = pendingStrings_.erase(it);
            } else {
                ++it;
            }
        }
        line = serializeBatch();
    }

    const std::size_t eventCount = events_.size();
    writeLine(line);
    if (!error_.empty()) {
        return;
    }
    for (const auto& entry : pendingStrings_) {
        emittedStringIds_.insert(entry.first);
    }
    emittedEvents_ += eventCount;
    nextSequence_ += eventCount;
    ++batchIndex_;
    events_.clear();
    pendingStrings_.clear();
}

void EventBuffer::finish() {
    if (finished_) {
        return;
    }
    flush();
    if (error_.empty()) {
        writeLine(serializeTrailer());
    }
    finished_ = true;
}

TraceSummary EventBuffer::summary() const {
    TraceSummary snapshot;
    snapshot.complete = complete_ && error_.empty();
    snapshot.eventCount = emittedEvents_;
    snapshot.droppedCount = droppedEvents_;
    snapshot.batchCount = batchIndex_;
    snapshot.droppedByKind = droppedByKind_;
    return snapshot;
}

const std::string& EventBuffer::error() const {
    return error_;
}

const char* EventBuffer::kindName(Kind kind) {
    switch (kind) {
    case Kind::StatementBegin:
        return "SB";
    case Kind::StatementEnd:
        return "SE";
    case Kind::Allocate:
        return "A";
    case Kind::RootSet:
        return "RS";
    case Kind::RootClear:
        return "RC";
    case Kind::FieldWrite:
        return "FW";
    case Kind::GcBegin:
        return "GB";
    case Kind::GcEnd:
        return "GE";
    case Kind::MarkVisit:
        return "MV";
    case Kind::SweepFree:
        return "SF";
    }
    return "";
}

bool EventBuffer::isStructural(Kind kind) {
    return kind == Kind::StatementBegin || kind == Kind::StatementEnd ||
           kind == Kind::GcBegin || kind == Kind::GcEnd;
}

bool EventBuffer::allowed(Kind kind) const {
    if (level_ == TraceLevel::Off) {
        return false;
    }
    if (isStructural(kind)) {
        return true;
    }
    if (kind == Kind::MarkVisit || kind == Kind::SweepFree) {
        return level_ == TraceLevel::Full;
    }
    return level_ == TraceLevel::Mutator || level_ == TraceLevel::Full;
}

std::uint32_t EventBuffer::intern(const std::string& value) {
    const auto found = stringIds_.find(value);
    if (found != stringIds_.end()) {
        if (emittedStringIds_.find(found->second) == emittedStringIds_.end()) {
            pendingStrings_.emplace(found->second, value);
        }
        return found->second;
    }
    if (stringIds_.size() >= std::numeric_limits<std::uint32_t>::max()) {
        complete_ = false;
        return 0;
    }
    const auto id = static_cast<std::uint32_t>(stringIds_.size());
    stringIds_.emplace(value, id);
    pendingStrings_.emplace(id, value);
    return id;
}

void EventBuffer::enqueue(TraceEvent event) {
    if (finished_ || !error_.empty() || !allowed(event.kind)) {
        return;
    }
    if (retainedEvents_ >= maxEvents_ && !isStructural(event.kind)) {
        drop(event.kind);
        return;
    }
    events_.push_back(event);
    ++retainedEvents_;
    if (events_.size() >= batchCapacity_) {
        flush();
    }
}

void EventBuffer::drop(Kind kind) {
    complete_ = false;
    ++droppedEvents_;
    ++droppedByKind_[kindName(kind)];
}

std::string EventBuffer::serializeBatch() const {
    JsonWriter json;
    json.beginObject();
    json.key("schema");
    json.string("gcd.trace-batch/1");
    json.key("runId");
    json.string(runId_);
    json.key("batch");
    json.number(batchIndex_);
    json.key("firstSeq");
    json.number(nextSequence_);
    json.key("lastSeq");
    json.number(nextSequence_ + events_.size() - 1);
    json.key("droppedTotal");
    json.number(droppedEvents_);
    json.key("strings");
    json.beginObject();
    for (const auto& entry : pendingStrings_) {
        json.key(std::to_string(entry.first));
        json.string(entry.second);
    }
    json.endObject();
    json.key("events");
    json.beginArray();

    std::uint64_t sequence = nextSequence_;
    for (const TraceEvent& event : events_) {
        json.beginArray();
        json.number(sequence++);
        json.string(kindName(event.kind));
        json.number(static_cast<std::uint64_t>(event.statementIndex));
        switch (event.kind) {
        case Kind::StatementBegin:
        case Kind::StatementEnd:
            break;
        case Kind::Allocate:
        case Kind::SweepFree:
            json.string(std::to_string(event.a));
            break;
        case Kind::RootSet:
            json.number(static_cast<std::uint64_t>(event.nameId));
            if (gc::ObjectHandle(event.a).isValid()) {
                json.string(std::to_string(event.a));
            } else {
                json.nullValue();
            }
            break;
        case Kind::RootClear:
            json.number(static_cast<std::uint64_t>(event.nameId));
            if (gc::ObjectHandle(event.a).isValid()) {
                json.string(std::to_string(event.a));
            } else {
                json.nullValue();
            }
            break;
        case Kind::FieldWrite:
            json.number(static_cast<std::uint64_t>(event.nameId));
            json.string(std::to_string(event.a));
            if (gc::ObjectHandle(event.b).isValid()) {
                json.string(std::to_string(event.b));
            } else {
                json.nullValue();
            }
            if (gc::ObjectHandle(event.c).isValid()) {
                json.string(std::to_string(event.c));
            } else {
                json.nullValue();
            }
            break;
        case Kind::GcBegin:
            json.number(event.a);
            break;
        case Kind::GcEnd:
            json.number(event.a);
            json.number(event.b);
            json.number(event.c);
            break;
        case Kind::MarkVisit:
            json.string(std::to_string(event.a));
            if (event.hasParent) {
                json.string(std::to_string(event.b));
            } else {
                json.nullValue();
            }
            if (event.hasRoot) {
                json.number(static_cast<std::uint64_t>(event.nameId));
            } else {
                json.nullValue();
            }
            break;
        }
        json.endArray();
    }
    json.endArray();
    json.endObject();
    return json.str();
}

std::string EventBuffer::serializeTrailer() const {
    JsonWriter json;
    json.beginObject();
    json.key("type");
    json.string("end");
    json.key("lastSeq");
    json.number(nextSequence_ - 1);
    json.key("complete");
    json.boolean(complete_ && error_.empty());
    json.key("droppedByKind");
    json.beginObject();
    for (const auto& entry : droppedByKind_) {
        json.key(entry.first);
        json.number(entry.second);
    }
    json.endObject();
    json.endObject();
    return json.str();
}

void EventBuffer::writeLine(const std::string& line) {
    if (!sink_.writeLine(line)) {
        error_ = sink_.error().empty() ? "trace sink failed" : sink_.error();
        complete_ = false;
        return;
    }
    bytesWritten_ += line.size() + 1;
}
