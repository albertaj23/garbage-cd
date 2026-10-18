#include "check.hpp"

#include <cstddef>
#include <string>
#include <vector>

#include "gc_interface.hpp"
#include "memory/heap.hpp"

namespace {

gc::ObjectHandle allocateTracked(gc::IHeap& heap) {
    const gc::ObjectHandle handle = heap.allocate();
    heap.setField(handle, "__self", handle);
    return handle;
}

void checkLive(gc::IHeap& heap, const std::vector<gc::ObjectHandle>& handles,
               const std::vector<bool>& expected) {
    CHECK_EQ(handles.size(), expected.size());
    for (std::size_t i = 0; i < handles.size(); ++i) {
        const bool live = heap.getField(handles[i], "__self") == handles[i];
        CHECK_EQ(live, expected[i]);
    }
}

void testRootedObjectSurvives() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto object = allocateTracked(heap);
    heap.setRoot("object", object);

    heap.collect();

    checkLive(heap, {object}, {true});
    CHECK_EQ(heap.getStats().liveObjectsAfterLastRun, 1U);
}

void testUnreachableObjectIsReclaimed() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto object = allocateTracked(heap);

    heap.collect();

    checkLive(heap, {object}, {false});
    CHECK_EQ(heap.getStats().objectsCollectedLastRun, 1U);
}

void testLongChainAndRootDrop() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    std::vector<gc::ObjectHandle> chain;
    chain.reserve(1000);
    for (std::size_t i = 0; i < 1000; ++i) {
        chain.push_back(allocateTracked(heap));
        if (i > 0) {
            heap.setField(chain[i - 1], "next", chain[i]);
        }
    }
    heap.setRoot("head", chain.front());

    heap.collect();
    checkLive(heap, chain, std::vector<bool>(chain.size(), true));

    heap.clearRoot("head");
    heap.collect();
    checkLive(heap, chain, std::vector<bool>(chain.size(), false));
}

void testOverlappingRoots() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto left = allocateTracked(heap);
    const auto right = allocateTracked(heap);
    const auto shared = allocateTracked(heap);
    heap.setField(left, "shared", shared);
    heap.setField(right, "shared", shared);
    heap.setRoot("left", left);
    heap.setRoot("right", right);

    heap.collect();
    checkLive(heap, {left, right, shared}, {true, true, true});

    heap.clearRoot("left");
    heap.collect();
    checkLive(heap, {left, right, shared}, {false, true, true});

    heap.clearRoot("right");
    heap.collect();
    checkLive(heap, {left, right, shared}, {false, false, false});
}

void testFanInKeepsTargetUntilLastReferrerIsRemoved() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto target = allocateTracked(heap);
    std::vector<gc::ObjectHandle> referrers;
    referrers.reserve(100);
    for (std::size_t i = 0; i < 100; ++i) {
        const auto referrer = allocateTracked(heap);
        heap.setField(referrer, "target", target);
        heap.setRoot("root-" + std::to_string(i), referrer);
        referrers.push_back(referrer);
    }

    heap.collect();
    checkLive(heap, referrers, std::vector<bool>(referrers.size(), true));
    CHECK_EQ(heap.getField(target, "__self"), target);

    for (std::size_t i = 0; i < 99; ++i) {
        heap.clearRoot("root-" + std::to_string(i));
    }
    heap.collect();
    checkLive(heap, referrers, [&] {
        std::vector<bool> expected(referrers.size(), false);
        expected.back() = true;
        return expected;
    }());
    CHECK_EQ(heap.getField(target, "__self"), target);

    heap.clearRoot("root-99");
    heap.collect();
    CHECK_EQ(heap.getField(target, "__self"), gc::ObjectHandle::invalid());
}

void testReachableCyclesSurvive() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto selfCycle = allocateTracked(heap);
    heap.setField(selfCycle, "self", selfCycle);
    heap.setRoot("self", selfCycle);

    std::vector<gc::ObjectHandle> cycle;
    for (std::size_t i = 0; i < 5; ++i) {
        cycle.push_back(allocateTracked(heap));
    }
    for (std::size_t i = 0; i < cycle.size(); ++i) {
        heap.setField(cycle[i], "next", cycle[(i + 1) % cycle.size()]);
    }
    heap.setRoot("cycle", cycle.front());

    heap.collect();
    checkLive(heap, {selfCycle}, {true});
    checkLive(heap, cycle, std::vector<bool>(cycle.size(), true));
}

void testUnreachableCyclesAndHangingCycleAreReclaimed() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto twoA = allocateTracked(heap);
    const auto twoB = allocateTracked(heap);
    heap.setField(twoA, "next", twoB);
    heap.setField(twoB, "next", twoA);

    std::vector<gc::ObjectHandle> fiveCycle;
    for (std::size_t i = 0; i < 5; ++i) {
        fiveCycle.push_back(allocateTracked(heap));
    }
    for (std::size_t i = 0; i < fiveCycle.size(); ++i) {
        heap.setField(fiveCycle[i], "next", fiveCycle[(i + 1) % fiveCycle.size()]);
    }

    const auto tailA = allocateTracked(heap);
    const auto tailB = allocateTracked(heap);
    const auto tailC = allocateTracked(heap);
    heap.setField(tailA, "next", tailB);
    heap.setField(tailB, "next", tailC);
    heap.setField(tailC, "next", tailB);

    heap.collect();

    checkLive(heap, {twoA, twoB}, {false, false});
    checkLive(heap, fiveCycle, std::vector<bool>(fiveCycle.size(), false));
    checkLive(heap, {tailA, tailB, tailC}, {false, false, false});
    CHECK_EQ(heap.getStats().liveObjectsAfterLastRun, 0U);
}

void testRootReplacementReleasesPreviousObject() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto previous = allocateTracked(heap);
    const auto replacement = allocateTracked(heap);
    heap.setRoot("variable", previous);
    heap.setRoot("variable", replacement);

    heap.collect();
    checkLive(heap, {previous, replacement}, {false, true});

    heap.clearRoot("variable");
    heap.collect();
    checkLive(heap, {previous, replacement}, {false, false});
}

void testRepeatedCollectionsAreStable() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto first = allocateTracked(heap);
    const auto second = allocateTracked(heap);
    heap.setField(first, "next", second);
    heap.setRoot("first", first);

    for (std::size_t i = 0; i < 100; ++i) {
        heap.collect();
        CHECK_EQ(heap.getStats().objectsCollectedLastRun, 0U);
        CHECK_EQ(heap.getStats().liveObjectsAfterLastRun, 2U);
        checkLive(heap, {first, second}, {true, true});
    }
    CHECK_EQ(heap.getStats().totalCollections, 100U);
}

void testStatsArithmetic() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto rooted = allocateTracked(heap);
    const auto garbageA = allocateTracked(heap);
    const auto garbageB = allocateTracked(heap);
    heap.setRoot("root", rooted);

    heap.collect();
    auto stats = heap.getStats();
    CHECK_EQ(stats.totalAllocations, 3U);
    CHECK_EQ(stats.totalCollections, 1U);
    CHECK_EQ(stats.objectsCollectedLastRun, 2U);
    CHECK_EQ(stats.liveObjectsAfterLastRun, 1U);
    std::size_t cumulativeFreed = stats.objectsCollectedLastRun;
    CHECK_EQ(stats.totalAllocations,
             cumulativeFreed + stats.liveObjectsAfterLastRun);

    const auto child = allocateTracked(heap);
    heap.setField(rooted, "child", child);
    heap.clearRoot("root");
    heap.setRoot("child", child);
    heap.collect();
    stats = heap.getStats();
    CHECK_EQ(stats.totalAllocations, 4U);
    CHECK_EQ(stats.totalCollections, 2U);
    CHECK_EQ(stats.objectsCollectedLastRun, 1U);
    CHECK_EQ(stats.liveObjectsAfterLastRun, 1U);
    cumulativeFreed += stats.objectsCollectedLastRun;
    CHECK_EQ(stats.totalAllocations,
             cumulativeFreed + stats.liveObjectsAfterLastRun);

    heap.clearRoot("child");
    heap.collect();
    stats = heap.getStats();
    CHECK_EQ(stats.totalCollections, 3U);
    CHECK_EQ(stats.objectsCollectedLastRun, 1U);
    CHECK_EQ(stats.liveObjectsAfterLastRun, 0U);
    CHECK_EQ(stats.totalAllocations, 4U);
    cumulativeFreed += stats.objectsCollectedLastRun;
    CHECK_EQ(stats.totalAllocations,
             cumulativeFreed + stats.liveObjectsAfterLastRun);
    checkLive(heap, {rooted, garbageA, garbageB, child},
              {false, false, false, false});
}

void testInvalidAndStaleHandlesDoNotCrash() {
    memory::Heap concrete;
    gc::IHeap& heap = concrete;
    const auto invalid = gc::ObjectHandle::invalid();
    const gc::ObjectHandle neverAllocated(1000000);
    const auto freed = allocateTracked(heap);

    heap.setRoot("invalid", invalid);
    heap.setRoot("never", neverAllocated);
    heap.collect();
    CHECK_EQ(heap.getField(invalid, "__self"), invalid);
    CHECK_EQ(heap.getField(neverAllocated, "__self"), invalid);
    CHECK_EQ(heap.getField(freed, "__self"), invalid);

    const auto survivor = allocateTracked(heap);
    heap.setRoot("survivor", survivor);
    heap.setRoot("stale", freed);
    heap.setField(invalid, "ignored", survivor);
    heap.setField(neverAllocated, "ignored", survivor);
    heap.setField(freed, "ignored", survivor);
    CHECK_EQ(heap.getField(survivor, "ignored"), invalid);
    heap.collect();
    CHECK_EQ(heap.getField(survivor, "__self"), survivor);
    CHECK_EQ(heap.getStats().liveObjectsAfterLastRun, 1U);
}

} // namespace

int main() {
    testRootedObjectSurvives();
    testUnreachableObjectIsReclaimed();
    testLongChainAndRootDrop();
    testOverlappingRoots();
    testFanInKeepsTargetUntilLastReferrerIsRemoved();
    testReachableCyclesSurvive();
    testUnreachableCyclesAndHangingCycleAreReclaimed();
    testRootReplacementReleasesPreviousObject();
    testRepeatedCollectionsAreStable();
    testStatsArithmetic();
    testInvalidAndStaleHandlesDoNotCrash();
}
