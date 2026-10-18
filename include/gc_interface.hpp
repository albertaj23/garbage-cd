#pragma once

// Shared contract between the interpreter/runtime (Prateek) and the
// memory subsystem (Akshat). Neither side includes the other's headers
// directly -- both depend only on this file.
//
// The interpreter must only ever see ObjectHandle and IHeap from here.
// It must never see memory::Object or any heap-internal data structure.

#include <cstddef>
#include <string>

namespace gc {

// Opaque handle to a heap-allocated object. The interpreter can store,
// copy, and compare handles, but cannot dereference or inspect them.
class ObjectHandle {
public:
    ObjectHandle() : id_(kInvalidId) {}
    explicit ObjectHandle(std::size_t id) : id_(id) {}

    bool isValid() const { return id_ != kInvalidId; }

    // Intended for use by the heap implementation only (e.g. as an index).
    std::size_t raw() const { return id_; }

    bool operator==(const ObjectHandle& other) const { return id_ == other.id_; }
    bool operator!=(const ObjectHandle& other) const { return !(*this == other); }

    static ObjectHandle invalid() { return ObjectHandle(); }

private:
    static constexpr std::size_t kInvalidId = static_cast<std::size_t>(-1);
    std::size_t id_;
};

// Snapshot of GC activity, returned to the interpreter after a collection
// or on request. Purely informational -- the interpreter cannot act on it
// beyond reporting it.
struct GCStats {
    std::size_t totalAllocations = 0;
    std::size_t totalCollections = 0;
    std::size_t objectsCollectedLastRun = 0;
    std::size_t liveObjectsAfterLastRun = 0;
};

// Interface implemented by the memory subsystem (memory::Heap) and
// consumed by the interpreter. This is the only way the interpreter
// interacts with managed memory.
class IHeap {
public:
    virtual ~IHeap() = default;

    // Allocates a new object and returns a handle to it.
    virtual ObjectHandle allocate() = 0;

    // Root management: the interpreter registers/clears the variable
    // bindings that are reachable from outside the heap.
    virtual void setRoot(const std::string& name, ObjectHandle handle) = 0;
    virtual void clearRoot(const std::string& name) = 0;

    // Field access on managed objects, addressed purely by handle.
    virtual void setField(ObjectHandle obj, const std::string& field, ObjectHandle target) = 0;
    virtual ObjectHandle getField(ObjectHandle obj, const std::string& field) const = 0;

    // Triggers a mark-sweep collection.
    virtual void collect() = 0;

    // Returns current GC statistics.
    virtual GCStats getStats() const = 0;
};

} // namespace gc
