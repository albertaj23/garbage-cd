#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "gc_interface.hpp"
#include "memory/diagnostics.hpp"

namespace memory {

struct MarkDiscovery {
    std::optional<gc::ObjectHandle> parent;
    std::optional<std::string> field;
    std::optional<std::string> root;
};

struct HeapFieldView {
    std::string name;
    gc::ObjectHandle target;
};

struct HeapObjectView {
    gc::ObjectHandle handle;
    std::uint64_t slot = 0;
    std::uint64_t generation = 0;           // 0 unless slot reuse is enabled
    std::optional<std::uint64_t> region;    // set only when regions are enabled
    std::uint64_t allocSeq = 0;
    std::uint32_t allocStatement = 0;
    bool marked = false;
    std::vector<HeapFieldView> fields;
    std::optional<MarkDiscovery> discoveredBy;
};

struct HeapRootView {
    std::string name;
    gc::ObjectHandle target;
};

class HeapView {
public:
    const std::vector<HeapObjectView>& objects() const {
        return objects_;
    }

    const std::vector<HeapRootView>& roots() const {
        return roots_;
    }

private:
    friend class Heap;

    std::vector<HeapObjectView> objects_;
    std::vector<HeapRootView> roots_;
};

class GcObserver {
public:
    virtual ~GcObserver() = default;

    virtual bool wantsMarkForest() const {
        return true;
    }

    virtual void onCollectionBegin(std::uint64_t gcIndex) = 0;
    virtual void onMarkVisit(gc::ObjectHandle child, const MarkDiscovery& discovery) = 0;
    virtual void onMarkComplete(const HeapView& view) = 0;
    virtual void onSweepFree(gc::ObjectHandle handle) = 0;
    virtual void onCollectionEnd(const CollectionRecord& record) = 0;
};

} // namespace memory
