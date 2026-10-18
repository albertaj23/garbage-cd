#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "gc_interface.hpp"
#include "memory/observer.hpp"

enum class TraceLevel {
    Off,
    Gc,
    Mutator,
    Full
};

class EventSink {
public:
    virtual ~EventSink() = default;
    virtual bool writeLine(const std::string& line) = 0;
    virtual const std::string& error() const = 0;
};

class FileSink final : public EventSink {
public:
    explicit FileSink(const std::string& path);
    ~FileSink() override;
    bool writeLine(const std::string& line) override;
    const std::string& error() const override;

private:
    std::FILE* output_ = nullptr;
    std::string error_;
};

class MemorySink final : public EventSink {
public:
    bool writeLine(const std::string& line) override;
    const std::string& error() const override;

    const std::vector<std::string>& lines() const;

private:
    std::vector<std::string> lines_;
    std::string error_;
};

struct TraceSummary {
    bool complete = true;
    std::uint64_t eventCount = 0;
    std::uint64_t droppedCount = 0;
    std::uint64_t batchCount = 0;
    std::map<std::string, std::uint64_t> droppedByKind;
};

class EventBuffer {
public:
    EventBuffer(EventSink& sink, std::string runId, std::size_t batchCapacity,
                TraceLevel level, std::uint64_t maxEvents = 1000000,
                std::uint64_t maxBytes = 64 * 1024 * 1024);

    void statementBegin(std::uint32_t statementIndex);
    void statementEnd(std::uint32_t statementIndex);
    void allocation(std::uint32_t statementIndex, gc::ObjectHandle handle);
    void rootSet(std::uint32_t statementIndex, const std::string& name,
                 gc::ObjectHandle handle);
    void rootClear(std::uint32_t statementIndex, const std::string& name,
                   gc::ObjectHandle handle);
    void fieldWrite(std::uint32_t statementIndex, const std::string& name,
                    gc::ObjectHandle object, gc::ObjectHandle target,
                    gc::ObjectHandle oldTarget);
    void collectionBegin(std::uint32_t statementIndex, std::uint64_t gcIndex);
    void collectionEnd(std::uint32_t statementIndex, const memory::CollectionRecord& record);
    void markVisit(std::uint32_t statementIndex, gc::ObjectHandle child,
                   const memory::MarkDiscovery& discovery);
    void sweepFree(std::uint32_t statementIndex, gc::ObjectHandle handle);
    void flush();
    void finish();

    TraceSummary summary() const;
    const std::string& error() const;

private:
    enum class Kind : std::uint8_t {
        StatementBegin,
        StatementEnd,
        Allocate,
        RootSet,
        RootClear,
        FieldWrite,
        GcBegin,
        GcEnd,
        MarkVisit,
        SweepFree
    };

    struct TraceEvent {
        Kind kind;
        std::uint32_t statementIndex;
        std::uint64_t a = 0;
        std::uint64_t b = 0;
        std::uint64_t c = 0;
        std::uint32_t nameId = 0;
        bool hasParent = false;
        bool hasRoot = false;
    };

    static const char* kindName(Kind kind);
    static bool isStructural(Kind kind);
    bool allowed(Kind kind) const;
    std::uint32_t intern(const std::string& value);
    void enqueue(TraceEvent event);
    void drop(Kind kind);
    std::string serializeBatch() const;
    std::string serializeTrailer() const;
    void writeLine(const std::string& line);

    EventSink& sink_;
    std::string runId_;
    std::size_t batchCapacity_;
    TraceLevel level_;
    std::uint64_t maxEvents_;
    std::uint64_t maxBytes_;
    std::vector<TraceEvent> events_;
    std::unordered_map<std::string, std::uint32_t> stringIds_;
    std::set<std::uint32_t> emittedStringIds_;
    std::map<std::uint32_t, std::string> pendingStrings_;
    std::map<std::string, std::uint64_t> droppedByKind_;
    std::uint64_t retainedEvents_ = 0;
    std::uint64_t emittedEvents_ = 0;
    std::uint64_t droppedEvents_ = 0;
    std::uint64_t nextSequence_ = 1;
    std::uint64_t batchIndex_ = 0;
    std::uint64_t bytesWritten_ = 0;
    bool complete_ = true;
    bool finished_ = false;
    std::string error_;
};
