#pragma once

// Seeded random mutator programs shared by the region, differential and property tests.

#include <cstddef>
#include <cstdint>
#include <random>
#include <string>
#include <vector>

#include "gc_interface.hpp"
#include "memory/heap.hpp"
#include "memory/observer.hpp"

namespace testops {

struct Variant {
    const char* name;
    memory::Heap::Options options;
    bool observer;
};

// A' (all off), B (regions), C (observer), D (regions + observer), E (slot reuse), E+B, E+D.
inline std::vector<Variant> allVariants() {
    return {
        {"A'", {0, false}, false},
        {"B64", {64, false}, false},
        {"B16", {16, false}, false},
        {"C", {0, false}, true},
        {"D", {64, false}, true},
        {"E", {0, true}, false},
        {"E+B", {16, true}, false},
        {"E+D", {64, true}, true},
    };
}

class NullObserver final : public memory::GcObserver {
public:
    void onCollectionBegin(std::uint64_t) override {}
    void onMarkVisit(gc::ObjectHandle, const memory::MarkDiscovery&) override {}
    void onMarkComplete(const memory::HeapView&) override {}
    void onSweepFree(gc::ObjectHandle) override {}
    void onCollectionEnd(const memory::CollectionRecord&) override {}
};

enum class Kind { Allocate, SetRoot, ClearRoot, SetField, Collect };

struct Op {
    Kind kind = Kind::Allocate;
    std::size_t object = 0;   // index into the allocation order
    std::size_t target = 0;   // index into the allocation order
    bool nullTarget = false;
    std::string name;         // root name or field name
};

inline std::vector<Op> generateOps(std::uint64_t seed, std::size_t minOps = 200,
                                   std::size_t extraOps = 1801) {
    std::mt19937_64 rng(seed);
    const auto choose = [&rng](std::size_t bound) { return static_cast<std::size_t>(rng() % bound); };
    const std::size_t count = minOps + choose(extraOps);
    std::vector<Op> ops;
    std::size_t allocated = 0;
    for (std::size_t i = 0; i < count; ++i) {
        const std::size_t kind = choose(5);
        Op op;
        if (kind == 0 || allocated == 0) {
            op.kind = Kind::Allocate;
            ++allocated;
        } else if (kind == 1) {
            op.kind = Kind::SetRoot;
            op.name = "root-" + std::to_string(choose(12));
            op.object = choose(allocated);
        } else if (kind == 2) {
            op.kind = Kind::ClearRoot;
            op.name = "root-" + std::to_string(choose(12));
        } else if (kind == 3) {
            op.kind = Kind::SetField;
            op.object = choose(allocated);
            op.nullTarget = choose(8) == 0;
            op.target = choose(allocated);
            op.name = "field-" + std::to_string(choose(8));
        } else {
            op.kind = Kind::Collect;
        }
        ops.push_back(op);
    }
    return ops;
}

// Applies one operation; `handles` is the per-heap list of allocation-order handles.
inline void apply(gc::IHeap& heap, std::vector<gc::ObjectHandle>& handles, const Op& op) {
    switch (op.kind) {
    case Kind::Allocate: {
        const gc::ObjectHandle handle = heap.allocate();
        heap.setField(handle, "__self", handle);
        handles.push_back(handle);
        break;
    }
    case Kind::SetRoot:
        heap.setRoot(op.name, handles[op.object]);
        break;
    case Kind::ClearRoot:
        heap.clearRoot(op.name);
        break;
    case Kind::SetField:
        heap.setField(handles[op.object], op.name,
                      op.nullTarget ? gc::ObjectHandle::invalid() : handles[op.target]);
        break;
    case Kind::Collect:
        heap.collect();
        break;
    }
}

} // namespace testops
