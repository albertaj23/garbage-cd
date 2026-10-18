#include "snapshot_writer.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <queue>
#include <unordered_map>
#include <unordered_set>

#include "json_writer.hpp"

namespace {

std::string handleString(gc::ObjectHandle handle) {
    return std::to_string(handle.raw());
}

bool validTarget(gc::ObjectHandle handle) {
    return handle.isValid();
}

} // namespace

SnapshotWriter::SnapshotWriter(std::string directory, std::string runId,
                               std::size_t maxObjects)
    : directory_(std::move(directory)), runId_(std::move(runId)),
      maxObjects_(std::max<std::size_t>(maxObjects, 1)) {}

SnapshotRecord SnapshotWriter::write(const std::string& point,
                                     const memory::HeapView& view,
                                     std::optional<std::uint64_t> gcIndex,
                                     std::uint32_t statementIndex) {
    SnapshotRecord record;
    record.index = nextIndex_++;
    record.gcIndex = gcIndex;
    record.point = point;
    record.objectCount = std::min<std::uint64_t>(view.objects().size(), maxObjects_);
    std::string filename = "snapshot-" + std::to_string(record.index) + ".json";
    std::filesystem::path outputPath = std::filesystem::path(directory_) / filename;
    record.path = outputPath.string();

    bool truncated = false;
    const std::string json =
        serialize(point, view, gcIndex, statementIndex, record.index, truncated);
    record.truncated = truncated;
    try {
        std::filesystem::create_directories(directory_);
        const std::filesystem::path temporaryPath = outputPath.string() + ".tmp";
        {
            std::ofstream output(temporaryPath, std::ios::binary | std::ios::trunc);
            if (!output) {
                throw std::runtime_error("unable to open snapshot output");
            }
            output << json << '\n';
            output.flush();
            if (!output) {
                throw std::runtime_error("unable to write snapshot output");
            }
        }
        std::error_code error;
        std::filesystem::rename(temporaryPath, outputPath, error);
        if (error) {
            std::filesystem::remove(temporaryPath);
            throw std::runtime_error("unable to publish snapshot output: " + error.message());
        }
        records_.push_back(record);
    } catch (const std::exception& exception) {
        error_ = exception.what();
    }
    return record;
}

std::string SnapshotWriter::serialize(const std::string& point,
                                      const memory::HeapView& view,
                                      std::optional<std::uint64_t> gcIndex,
                                      std::uint32_t statementIndex, std::uint64_t index,
                                      bool& truncated) const {
    const auto& objects = view.objects();
    const auto& roots = view.roots();
    std::unordered_map<std::size_t, const memory::HeapObjectView*> byHandle;
    byHandle.reserve(objects.size());
    std::uint64_t totalEdges = 0;
    for (const auto& object : objects) {
        byHandle.emplace(object.handle.raw(), &object);
        for (const auto& field : object.fields) {
            if (validTarget(field.target)) {
                ++totalEdges;
            }
        }
    }

    std::vector<const memory::HeapObjectView*> selected;
    selected.reserve(std::min(objects.size(), maxObjects_));
    if (objects.size() <= maxObjects_) {
        for (const auto& object : objects) {
            selected.push_back(&object);
        }
    } else {
        std::queue<const memory::HeapObjectView*> pending;
        std::unordered_set<std::size_t> included;
        for (const auto& root : roots) {
            const auto target = byHandle.find(root.target.raw());
            if (validTarget(root.target) && target != byHandle.end() &&
                included.insert(root.target.raw()).second) {
                pending.push(target->second);
            }
        }
        while (!pending.empty() && selected.size() < maxObjects_) {
            const memory::HeapObjectView* object = pending.front();
            pending.pop();
            selected.push_back(object);
            for (const auto& field : object->fields) {
                const auto target = byHandle.find(field.target.raw());
                if (validTarget(field.target) && target != byHandle.end() &&
                    included.insert(field.target.raw()).second) {
                    pending.push(target->second);
                }
            }
        }
        for (const auto& object : objects) {
            if (selected.size() >= maxObjects_) {
                break;
            }
            if (included.insert(object.handle.raw()).second) {
                selected.push_back(&object);
            }
        }
    }
    truncated = selected.size() < objects.size();

    JsonWriter json;
    json.beginObject();
    json.key("schema");
    json.string("gcd.heap-snapshot/1");
    json.key("runId");
    json.string(runId_);
    json.key("index");
    json.number(index);
    json.key("point");
    json.string(point);
    json.key("gcIndex");
    if (gcIndex) {
        json.number(*gcIndex);
    } else {
        json.nullValue();
    }
    json.key("statementIndex");
    json.number(static_cast<std::uint64_t>(statementIndex));
    json.key("totalObjects");
    json.number(static_cast<std::uint64_t>(objects.size()));
    json.key("totalEdges");
    json.number(totalEdges);
    json.key("truncated");
    json.boolean(truncated);
    json.key("roots");
    json.beginArray();
    for (const auto& root : roots) {
        json.beginObject();
        json.key("name");
        json.string(root.name);
        json.key("target");
        json.string(handleString(root.target));
        json.endObject();
    }
    json.endArray();
    json.key("objects");
    json.beginArray();
    for (const memory::HeapObjectView* object : selected) {
        json.beginObject();
        json.key("id");
        json.string(handleString(object->handle));
        json.key("slot");
        json.number(object->slot);
        json.key("generation");
        json.number(object->generation);
        json.key("region");
        if (object->region) {
            json.number(*object->region);
        } else {
            json.nullValue();
        }
        json.key("allocSeq");
        json.number(object->allocSeq);
        json.key("allocStatement");
        json.number(static_cast<std::uint64_t>(object->allocStatement));
        json.key("marked");
        if (point == "mark_complete") {
            json.boolean(object->marked);
        } else {
            json.nullValue();
        }
        json.key("fields");
        json.beginArray();
        for (const auto& field : object->fields) {
            json.beginObject();
            json.key("name");
            json.string(field.name);
            json.key("target");
            if (validTarget(field.target)) {
                json.string(handleString(field.target));
            } else {
                json.nullValue();
            }
            json.endObject();
        }
        json.endArray();
        if (object->discoveredBy) {
            json.key("discoveredBy");
            json.beginObject();
            json.key("parent");
            if (object->discoveredBy->parent) {
                json.string(handleString(*object->discoveredBy->parent));
            } else {
                json.nullValue();
            }
            json.key("field");
            if (object->discoveredBy->field) {
                json.string(*object->discoveredBy->field);
            } else {
                json.nullValue();
            }
            json.key("root");
            if (object->discoveredBy->root) {
                json.string(*object->discoveredBy->root);
            } else {
                json.nullValue();
            }
            json.endObject();
        }
        json.endObject();
    }
    json.endArray();
    json.endObject();
    return json.str();
}

const std::vector<SnapshotRecord>& SnapshotWriter::records() const {
    return records_;
}

const std::string& SnapshotWriter::error() const {
    return error_;
}
