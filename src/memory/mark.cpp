#include "memory/heap.hpp"

#include <algorithm>
#include <chrono>
#include <optional>
#include <vector>

// Mark phase of the mark-sweep collector.
// Starts from GC roots and traverses the object graph.

namespace memory {

void Heap::mark(CollectionRecord& record) {
    if (observer_ && observer_->wantsMarkForest()) {
        markImpl<true>(record);
    } else {
        markImpl<false>(record);
    }
}

template <bool RecordParents>
void Heap::markImpl(CollectionRecord& record) {
    const auto start = std::chrono::steady_clock::now();
    if constexpr (RecordParents) {
        discoveries_.assign(objects_.size(), std::nullopt);
    } else if (!discoveries_.empty()) {
        discoveries_.clear();  // an earlier observed collection's forest is stale now
    }
    // Start every collection with all objects unmarked.
    for (std::size_t i = 0; i < objects_.size(); ++i) {
        ++record.slotsScanned;
        if (slotInUse_[i] && objects_[i] != nullptr) {
            ++record.liveBefore;
            objects_[i]->marked = false;
        }
    }

    if constexpr (RecordParents) {
        struct WorkItem {
            gc::ObjectHandle handle;
            std::optional<gc::ObjectHandle> parent;
            std::optional<std::string> field;
            std::optional<std::string> root;
        };
        std::vector<WorkItem> worklist;
        for (const auto& root : roots_) {
            if (root.second.isValid()) {
                worklist.push_back(WorkItem{root.second, std::nullopt, std::nullopt, root.first});
                ++record.refsPushed;
            }
        }
        record.worklistPeak = worklist.size();

        while (!worklist.empty()) {
            WorkItem item = std::move(worklist.back());
            worklist.pop_back();
            Object* object = resolve(item.handle);
            if (object == nullptr || object->marked) {
                continue;
            }

            object->marked = true;
            ++record.marked;
            const MarkDiscovery discovery{item.parent, item.field, item.root};
            discoveries_[slotOf(item.handle)] = discovery;
            observer_->onMarkVisit(item.handle, discovery);

            for (const auto& field : object->fields()) {
                ++record.fieldsScanned;
                if (field.second.isValid()) {
                    worklist.push_back(
                        WorkItem{field.second, item.handle, field.first, std::nullopt});
                    ++record.refsPushed;
                    record.worklistPeak =
                        std::max<std::uint64_t>(record.worklistPeak, worklist.size());
                }
            }
        }
    } else {
        std::vector<gc::ObjectHandle> worklist;
        for (const auto& root : roots_) {
            if (root.second.isValid()) {
                worklist.push_back(root.second);
                ++record.refsPushed;
            }
        }
        record.worklistPeak = worklist.size();

        while (!worklist.empty()) {
            gc::ObjectHandle handle = worklist.back();
            worklist.pop_back();
            Object* object = resolve(handle);
            if (object == nullptr || object->marked) {
                continue;
            }

            object->marked = true;
            ++record.marked;
            for (const auto& field : object->fields()) {
                ++record.fieldsScanned;
                if (field.second.isValid()) {
                    worklist.push_back(field.second);
                    ++record.refsPushed;
                    record.worklistPeak =
                        std::max<std::uint64_t>(record.worklistPeak, worklist.size());
                }
            }
        }
    }
    record.markNs = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - start)
            .count());
}

} // namespace memory
