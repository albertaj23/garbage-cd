#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>

#include "gc_interface.hpp"
#include "memory/heap.hpp"
#include "memory/observer.hpp"
#include "event_buffer.hpp"
#include "snapshot_writer.hpp"

class RunnerObserver final : public memory::GcObserver {
public:
    RunnerObserver(EventBuffer* events, SnapshotWriter* snapshots, bool recordMarkForest);

    bool wantsMarkForest() const override;
    void setCurrentStatement(std::uint32_t statementIndex);
    const std::string& error() const;

    void onCollectionBegin(std::uint64_t gcIndex) override;
    void onMarkVisit(gc::ObjectHandle child,
                     const memory::MarkDiscovery& discovery) override;
    void onMarkComplete(const memory::HeapView& view) override;
    void onSweepFree(gc::ObjectHandle handle) override;
    void onCollectionEnd(const memory::CollectionRecord& record) override;

private:
    EventBuffer* events_;
    SnapshotWriter* snapshots_;
    std::uint32_t currentStatement_ = 0;
    std::uint64_t currentGcIndex_ = 0;
    bool recordMarkForest_;
    std::string error_;
};

class TracingHeap final : public gc::IHeap {
public:
    struct CallCounts {
        std::uint64_t allocations = 0;
        std::uint64_t rootSets = 0;
        std::uint64_t rootClears = 0;
        std::uint64_t fieldWrites = 0;
        std::uint64_t fieldReads = 0;
        std::uint64_t collections = 0;
    };

    explicit TracingHeap(memory::Heap& heap, EventBuffer* events = nullptr);

    void beginStatement(std::uint32_t statementIndex);
    void endStatement(std::uint32_t statementIndex);

    gc::ObjectHandle allocate() override;
    void setRoot(const std::string& name, gc::ObjectHandle handle) override;
    void clearRoot(const std::string& name) override;
    void setField(gc::ObjectHandle obj, const std::string& field,
                  gc::ObjectHandle target) override;
    gc::ObjectHandle getField(gc::ObjectHandle obj, const std::string& field) const override;
    void collect() override;
    gc::GCStats getStats() const override;

    const memory::GcDiagnostics& diagnostics() const;
    const CallCounts& calls() const;

private:
    memory::Heap& heap_;
    EventBuffer* events_;
    std::uint32_t currentStatement_ = 0;
    std::unordered_map<std::string, gc::ObjectHandle> roots_;
    mutable CallCounts calls_;
};
