#pragma once

// memory::Heap -- concrete managed heap, implements gc::IHeap.
// Owned by Akshat. This is the only memory-subsystem type the rest of
// the project constructs directly; everyone else talks to it through
// the gc::IHeap interface.

#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "gc_interface.hpp"
#include "memory/diagnostics.hpp"
#include "memory/observer.hpp"
#include "memory/object.hpp"
#include "memory/region_table.hpp"

namespace memory {

class Heap : public gc::IHeap {
public:
    struct Options {
        // 0 disables regions; otherwise a power of two (E.2 uses 16..256).
        std::uint32_t regionSize = 0;
        // Reuse freed slots through a LIFO free list, with generation-checked handles (E.6).
        bool slotReuse = false;
    };

    Heap() : Heap(Options{}) {}
    explicit Heap(const Options& options);

    gc::ObjectHandle allocate() override;

    void setRoot(const std::string& name, gc::ObjectHandle handle) override;
    void clearRoot(const std::string& name) override;

    void setField(gc::ObjectHandle obj, const std::string& field, gc::ObjectHandle target) override;
    gc::ObjectHandle getField(gc::ObjectHandle obj, const std::string& field) const override;

    void collect() override;

    gc::GCStats getStats() const override;
    const GcDiagnostics& diagnostics() const;
    void setObserver(GcObserver* observer);
    void setCurrentStatement(std::uint32_t statementIndex);
    HeapView view() const;
    void verifyInvariants() const;

    const Options& options() const { return options_; }
    // I6: throws std::logic_error if the region counters differ from a from-scratch recomputation.
    void verifyRegions() const;
    // Region metadata snapshot (empty when regions are disabled). `verify` runs verifyRegions()
    // to fill `verified`; pass false to measure the export alone.
    RegionGraph regionGraph(bool verify = true) const;
    // Test hook (G.1 row 12): lowers the generation at which a slot is retired.
    void setGenerationLimitForTesting(std::uint32_t limit);
    std::size_t slotCount() const { return objects_.size(); }

private:
    // Mark-sweep phases, implemented in mark.cpp and sweep.cpp. The mark phase is a template on
    // whether the mark spanning forest is recorded, so an unobserved collection does no
    // parent bookkeeping.
    void mark(CollectionRecord& record);
    template <bool RecordParents>
    void markImpl(CollectionRecord& record);
    void sweep(CollectionRecord& record);
    HeapView makeView() const;

    Object* resolve(gc::ObjectHandle handle) const;
    std::size_t slotOf(gc::ObjectHandle handle) const;
    gc::ObjectHandle handleFor(std::size_t slot) const;

    std::vector<std::unique_ptr<Object>> objects_;   // slot index == ObjectHandle::raw()
    std::vector<bool> slotInUse_;                     // true if the slot holds a live allocation
    std::unordered_map<std::string, gc::ObjectHandle> roots_;
    gc::GCStats stats_;
    GcDiagnostics diagnostics_;
    GcObserver* observer_ = nullptr;
    std::uint32_t currentStatement_ = 0;

    Options options_;
    RegionTable regions_;
    std::vector<std::uint32_t> generations_;   // per slot; used only with slot reuse
    std::vector<std::size_t> freeSlots_;       // LIFO free list; used only with slot reuse
    std::uint32_t generationLimit_ = 0x80000000u;
    // Mark spanning forest, indexed by slot. Filled only while an observer asks for it, so the
    // common object stays small and the unobserved mark loop does no parent bookkeeping.
    std::vector<std::optional<MarkDiscovery>> discoveries_;
};

} // namespace memory
