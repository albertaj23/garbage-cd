#include "memory/heap.hpp"

#include <vector>

// Mark phase of the mark-sweep collector.
// Starts from GC roots and traverses the object graph.

namespace memory {

void Heap::mark() {
    // Start every collection with all objects unmarked.
    for (std::size_t i = 0; i < objects_.size(); ++i) {
        if (slotInUse_[i] && objects_[i] != nullptr) {
            objects_[i]->marked = false;
        }
    }

    // Worklist for graph traversal.
    std::vector<gc::ObjectHandle> worklist;

    // Start traversal from all GC roots.
    for (const auto& root : roots_) {
        if (root.second.isValid()) {
            worklist.push_back(root.second);
        }
    }

    // Traverse all reachable objects.
    while (!worklist.empty()) {
        gc::ObjectHandle handle = worklist.back();
        worklist.pop_back();

        Object* object = resolve(handle);

        // Invalid/stale handle or already visited object.
        if (object == nullptr || object->marked) {
            continue;
        }

        // Mark this object as reachable.
        object->marked = true;

        // Follow every object reference stored in its fields.
        for (const auto& field : object->fields()) {
            gc::ObjectHandle target = field.second;

            if (target.isValid()) {
                worklist.push_back(target);
            }
        }
    }
}

} // namespace memory
