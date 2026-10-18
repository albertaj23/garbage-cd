#include "memory/heap.hpp"

#include <chrono>

namespace memory {

void Heap::sweep(CollectionRecord& record) {
    const auto start = std::chrono::steady_clock::now();
    std::size_t collected = 0;
    std::size_t live = 0;

    for (std::size_t i = 0; i < objects_.size(); ++i) {
        ++record.slotsScanned;
        if (!slotInUse_[i] || objects_[i] == nullptr) {
            continue;
        }

        if (objects_[i]->marked) {
            objects_[i]->marked = false;
            ++live;
        } else {
            if (observer_) {
                observer_->onSweepFree(handleFor(i));
            }
            if (regions_.enabled()) {
                for (const auto& field : objects_[i]->fields()) {
                    if (field.second.isValid()) {
                        regions_.onEdgeRemoved(i, slotOf(field.second));
                    }
                }
                regions_.onFree(i);
            }
            const std::uint64_t fieldCount = objects_[i]->fields().size();
            record.fieldNodesFreed += fieldCount;
            diagnostics_.currentFieldNodes -= fieldCount;
            objects_[i].reset();
            slotInUse_[i] = false;
            ++collected;
            if (options_.slotReuse) {
                // Invalidate every outstanding handle to this slot. A slot whose generation
                // reaches the limit is retired rather than wrapped, so a stale handle can
                // never alias a later object.
                if (++generations_[i] >= generationLimit_) {
                    ++diagnostics_.slotsRetired;
                } else {
                    freeSlots_.push_back(i);
                }
            }
        }
    }

    stats_.objectsCollectedLastRun = collected;
    stats_.liveObjectsAfterLastRun = live;
    record.freed = collected;
    record.liveAfter = live;
    record.sweepNs = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - start)
            .count());
}

} // namespace memory
