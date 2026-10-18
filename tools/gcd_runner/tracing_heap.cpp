#include "tracing_heap.hpp"

RunnerObserver::RunnerObserver(EventBuffer* events, SnapshotWriter* snapshots,
                               bool recordMarkForest)
    : events_(events), snapshots_(snapshots), recordMarkForest_(recordMarkForest) {}

bool RunnerObserver::wantsMarkForest() const {
    return recordMarkForest_;
}

void RunnerObserver::setCurrentStatement(std::uint32_t statementIndex) {
    currentStatement_ = statementIndex;
}

const std::string& RunnerObserver::error() const {
    return error_;
}

void RunnerObserver::onCollectionBegin(std::uint64_t gcIndex) {
    currentGcIndex_ = gcIndex;
    if (events_) {
        events_->collectionBegin(currentStatement_, gcIndex);
    }
}

void RunnerObserver::onMarkVisit(gc::ObjectHandle child,
                                 const memory::MarkDiscovery& discovery) {
    if (events_) {
        events_->markVisit(currentStatement_, child, discovery);
    }
}

void RunnerObserver::onMarkComplete(const memory::HeapView& view) {
    if (snapshots_) {
        snapshots_->write("mark_complete", view, currentGcIndex_, currentStatement_);
        if (!snapshots_->error().empty()) {
            error_ = snapshots_->error();
        }
    }
}

void RunnerObserver::onSweepFree(gc::ObjectHandle handle) {
    if (events_) {
        events_->sweepFree(currentStatement_, handle);
    }
}

void RunnerObserver::onCollectionEnd(const memory::CollectionRecord& record) {
    if (events_) {
        events_->collectionEnd(currentStatement_, record);
    }
}

TracingHeap::TracingHeap(memory::Heap& heap, EventBuffer* events)
    : heap_(heap), events_(events) {}

void TracingHeap::beginStatement(std::uint32_t statementIndex) {
    currentStatement_ = statementIndex;
    heap_.setCurrentStatement(statementIndex);
    if (events_) {
        events_->statementBegin(statementIndex);
    }
}

void TracingHeap::endStatement(std::uint32_t statementIndex) {
    if (events_) {
        events_->statementEnd(statementIndex);
    }
}

gc::ObjectHandle TracingHeap::allocate() {
    ++calls_.allocations;
    const gc::ObjectHandle handle = heap_.allocate();
    if (events_) {
        events_->allocation(currentStatement_, handle);
    }
    return handle;
}

void TracingHeap::setRoot(const std::string& name, gc::ObjectHandle handle) {
    ++calls_.rootSets;
    heap_.setRoot(name, handle);
    roots_[name] = handle;
    if (events_) {
        events_->rootSet(currentStatement_, name, handle);
    }
}

void TracingHeap::clearRoot(const std::string& name) {
    ++calls_.rootClears;
    const auto found = roots_.find(name);
    const gc::ObjectHandle oldTarget =
        found == roots_.end() ? gc::ObjectHandle::invalid() : found->second;
    heap_.clearRoot(name);
    roots_.erase(name);
    if (events_) {
        events_->rootClear(currentStatement_, name, oldTarget);
    }
}

void TracingHeap::setField(gc::ObjectHandle obj, const std::string& field,
                           gc::ObjectHandle target) {
    ++calls_.fieldWrites;
    const gc::ObjectHandle oldTarget = heap_.getField(obj, field);
    heap_.setField(obj, field, target);
    if (events_) {
        events_->fieldWrite(currentStatement_, field, obj, target, oldTarget);
    }
}

gc::ObjectHandle TracingHeap::getField(gc::ObjectHandle obj, const std::string& field) const {
    ++calls_.fieldReads;
    return heap_.getField(obj, field);
}

void TracingHeap::collect() {
    ++calls_.collections;
    heap_.collect();
}

gc::GCStats TracingHeap::getStats() const {
    return heap_.getStats();
}

const memory::GcDiagnostics& TracingHeap::diagnostics() const {
    return heap_.diagnostics();
}

const TracingHeap::CallCounts& TracingHeap::calls() const {
    return calls_;
}
