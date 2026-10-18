// Smoke tests for the memory subsystem (V1). Reclamation, invariants and the V2 variants are
// covered by tests/v2/. Owned by Akshat.
// Plain asserts, no external test framework.

#include <cassert>
#include <iostream>

#include "memory/heap.hpp"

int main() {
    memory::Heap heap;

    gc::ObjectHandle a = heap.allocate();
    gc::ObjectHandle b = heap.allocate();
    assert(a.isValid());
    assert(b.isValid());
    assert(a != b);

    heap.setRoot("a", a);
    heap.setField(a, "ref", b);
    assert(heap.getField(a, "ref") == b);

    gc::GCStats statsBefore = heap.getStats();
    assert(statsBefore.totalAllocations == 2);
    assert(statsBefore.totalCollections == 0);

    heap.collect(); // a and b are both reachable from root "a", so nothing is freed

    gc::GCStats statsAfter = heap.getStats();
    assert(statsAfter.totalCollections == 1);

    heap.clearRoot("a");

    std::cout << "gc_tests: all smoke tests passed.\n";
    return 0;
}
