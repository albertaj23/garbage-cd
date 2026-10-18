#include "check.hpp"

#include <cstdint>
#include <iostream>
#include <vector>

#include "memory/heap.hpp"
#include "random_ops.hpp"

namespace {

memory::Heap::Options reuse() {
    memory::Heap::Options options;
    options.slotReuse = true;
    return options;
}

std::uint64_t slotOf(gc::ObjectHandle handle) { return handle.raw() & 0xFFFFFFFFull; }
std::uint64_t generationOf(gc::ObjectHandle handle) { return handle.raw() >> 32; }

void testEncodingAndSentinel() {
    memory::Heap heap(reuse());
    const auto first = heap.allocate();
    CHECK(first.isValid());
    CHECK_EQ(first.raw(), (static_cast<std::size_t>(1) << 32) | 0U);
    CHECK(first != gc::ObjectHandle::invalid());
    CHECK_EQ(generationOf(first), 1U);
    // Without reuse the handle is still the plain slot index, as in V1.
    memory::Heap plain;
    CHECK_EQ(plain.allocate().raw(), 0U);
}

void testStaleHandleNeverResolvesAfterReuse() {
    memory::Heap heap(reuse());
    const auto old = heap.allocate();
    heap.setField(old, "x", old);
    heap.collect();  // unreachable: freed, slot 0 goes on the free list
    const auto fresh = heap.allocate();
    CHECK_EQ(slotOf(fresh), slotOf(old));
    CHECK_EQ(generationOf(fresh), 2U);
    CHECK(fresh != old);
    CHECK(heap.getField(old, "x") == gc::ObjectHandle::invalid());
    heap.setField(old, "poison", fresh);       // stale source: no-op
    CHECK(heap.getField(fresh, "poison") == gc::ObjectHandle::invalid());
    heap.setField(fresh, "ref", old);          // stale target: stored as null
    CHECK(heap.getField(fresh, "ref") == gc::ObjectHandle::invalid());
    heap.setRoot("r", old);                    // stale root: normalised to invalid
    heap.collect();
    CHECK_EQ(heap.getStats().liveObjectsAfterLastRun, 0U);
    heap.verifyInvariants();
}

void testFreeListIsLifoAndBoundsSlotCount() {
    memory::Heap heap(reuse());
    std::vector<gc::ObjectHandle> first;
    for (int i = 0; i < 3; ++i) {
        first.push_back(heap.allocate());
    }
    heap.collect();  // frees slots 0, 1, 2 in that order
    CHECK_EQ(slotOf(heap.allocate()), 2U);
    CHECK_EQ(slotOf(heap.allocate()), 1U);
    CHECK_EQ(slotOf(heap.allocate()), 0U);
    CHECK_EQ(heap.slotCount(), 3U);
    for (int round = 0; round < 500; ++round) {
        heap.collect();
        for (int i = 0; i < 3; ++i) {
            heap.allocate();
        }
    }
    CHECK_EQ(heap.slotCount(), 3U);  // collection scans peak live slots, not all allocations
    for (const auto handle : first) {
        CHECK(heap.getField(handle, "__none") == gc::ObjectHandle::invalid());
    }
    // The same program without reuse keeps growing.
    memory::Heap plain;
    for (int round = 0; round < 10; ++round) {
        for (int i = 0; i < 3; ++i) {
            plain.allocate();
        }
        plain.collect();
    }
    CHECK_EQ(plain.slotCount(), 30U);
}

void testGenerationRetiresAtTheLimit() {
    memory::Heap heap(reuse());
    heap.setGenerationLimitForTesting(4);
    std::vector<gc::ObjectHandle> everything;
    // The slot is used with generations 1, 2 and 3; freeing the third use would reach 4 and retires it.
    for (int use = 0; use < 3; ++use) {
        everything.push_back(heap.allocate());
        CHECK_EQ(slotOf(everything.back()), 0U);
        CHECK_EQ(generationOf(everything.back()), static_cast<std::uint64_t>(use + 1));
        heap.collect();
    }
    CHECK_EQ(heap.diagnostics().slotsRetired, 1U);
    const auto next = heap.allocate();
    CHECK_EQ(slotOf(next), 1U);  // slot 0 was retired, so a new slot is appended
    CHECK_EQ(heap.slotCount(), 2U);
    for (const auto stale : everything) {
        CHECK(heap.getField(stale, "__none") == gc::ObjectHandle::invalid());
        heap.setRoot("stale", stale);
        heap.collect();
        CHECK_EQ(heap.getStats().liveObjectsAfterLastRun, 0U);
        heap.setField(next, "x", stale);
        CHECK(heap.getField(next, "x") == gc::ObjectHandle::invalid());
    }
    heap.collect();  // I5 is only defined right after a collection
    heap.verifyInvariants();
}

// I8 across random programs: a handle taken before its object was freed never resolves again.
void testRandomProgramsNeverResurrectHandles() {
    for (std::uint64_t seed = 1; seed <= 100; ++seed) {
        memory::Heap heap(reuse());
        heap.setGenerationLimitForTesting(6);
        std::vector<gc::ObjectHandle> handles;
        std::vector<gc::ObjectHandle> dead;
        for (const auto& op : testops::generateOps(seed, 100, 600)) {
            const auto before = heap.view();
            testops::apply(heap, handles, op);
            if (op.kind == testops::Kind::Collect) {
                std::vector<gc::ObjectHandle> alive;
                const auto afterView = heap.view();
                for (const auto& object : afterView.objects()) {
                    alive.push_back(object.handle);
                }
                for (const auto& object : before.objects()) {
                    bool survived = false;
                    for (const auto handle : alive) {
                        survived = survived || handle == object.handle;
                    }
                    if (!survived) {
                        dead.push_back(object.handle);
                    }
                }
            }
            for (const auto handle : dead) {
                CHECK(heap.getField(handle, "__self") == gc::ObjectHandle::invalid());
            }
        }
        heap.collect();
        heap.verifyInvariants();
    }
}

} // namespace

int main() {
    testEncodingAndSentinel();
    testStaleHandleNeverResolvesAfterReuse();
    testFreeListIsLifoAndBoundsSlotCount();
    testGenerationRetiresAtTheLimit();
    testRandomProgramsNeverResurrectHandles();
    std::cout << "handle_reuse_tests: passed\n";
}
