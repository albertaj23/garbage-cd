#include "check.hpp"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "memory/heap.hpp"

namespace {

class RecordingObserver final : public memory::GcObserver {
public:
    void onCollectionBegin(std::uint64_t gcIndex) override {
        begun.push_back(gcIndex);
    }

    void onMarkVisit(gc::ObjectHandle child,
                     const memory::MarkDiscovery& discovery) override {
        visits.emplace_back(child, discovery);
    }

    void onMarkComplete(const memory::HeapView& heapView) override {
        view = heapView;
    }

    void onSweepFree(gc::ObjectHandle handle) override {
        freed.push_back(handle);
    }

    void onCollectionEnd(const memory::CollectionRecord& record) override {
        ended.push_back(record);
    }

    std::vector<std::uint64_t> begun;
    std::vector<std::pair<gc::ObjectHandle, memory::MarkDiscovery>> visits;
    memory::HeapView view;
    std::vector<gc::ObjectHandle> freed;
    std::vector<memory::CollectionRecord> ended;
};

void testFiveObjectGraphCounters() {
    memory::Heap heap;
    const auto a = heap.allocate();
    const auto b = heap.allocate();
    const auto c = heap.allocate();
    const auto d = heap.allocate();
    const auto e = heap.allocate();
    heap.setField(a, "left", b);
    heap.setField(a, "right", c);
    heap.setField(b, "next", d);
    heap.setField(c, "next", d);
    heap.setField(d, "next", e);
    heap.setRoot("root", a);

    heap.collect();

    const auto& records = heap.diagnostics().collections;
    CHECK_EQ(records.size(), 1U);
    const auto& record = records.front();
    CHECK_EQ(record.gcIndex, 1U);
    CHECK_EQ(record.liveBefore, 5U);
    CHECK_EQ(record.marked, 5U);
    CHECK_EQ(record.freed, 0U);
    CHECK_EQ(record.liveAfter, 5U);
    CHECK_EQ(record.fieldsScanned, 5U);
    CHECK_EQ(record.refsPushed, 6U);
    CHECK_EQ(record.slotsScanned, 10U);
    CHECK(record.worklistPeak > 0);
    CHECK(record.totalNs >= record.markNs + record.sweepNs);
    CHECK_EQ(heap.getStats().totalCollections, 1U);
    CHECK_EQ(heap.getStats().liveObjectsAfterLastRun, 5U);
}

void testOneLiveObjectAfterOneMillionGarbageSlots() {
    constexpr std::uint64_t garbageCount = 1000000;
    memory::Heap heap;
    const auto live = heap.allocate();
    heap.setRoot("live", live);
    for (std::uint64_t i = 0; i < garbageCount; ++i) {
        heap.allocate();
    }

    heap.collect();

    const auto& record = heap.diagnostics().collections.front();
    CHECK_EQ(record.liveBefore, garbageCount + 1);
    CHECK_EQ(record.marked, 1U);
    CHECK_EQ(record.freed, garbageCount);
    CHECK_EQ(record.liveAfter, 1U);
    CHECK_EQ(record.fieldsScanned, 0U);
    CHECK_EQ(record.refsPushed, 1U);
    CHECK_EQ(record.slotsScanned, (garbageCount + 1) * 2);
    CHECK_EQ(heap.getStats().objectsCollectedLastRun, garbageCount);
}

void testFieldNodeAccounting() {
    memory::Heap heap;
    const auto first = heap.allocate();
    const auto second = heap.allocate();
    heap.setField(first, "next", second);
    heap.setField(first, "next", second);
    heap.setField(second, "next", first);
    heap.setRoot("first", first);
    heap.collect();
    CHECK_EQ(heap.diagnostics().currentFieldNodes, 2U);
    CHECK_EQ(heap.diagnostics().collections.back().fieldNodesFreed, 0U);

    heap.clearRoot("first");
    heap.collect();
    CHECK_EQ(heap.diagnostics().currentFieldNodes, 0U);
    CHECK_EQ(heap.diagnostics().collections.back().fieldNodesFreed, 2U);
}

void testMarkForestObserverAndHeapView() {
    memory::Heap heap;
    RecordingObserver observer;
    heap.setObserver(&observer);
    heap.setCurrentStatement(42);
    const auto first = heap.allocate();
    const auto second = heap.allocate();
    const auto third = heap.allocate();
    const auto fourth = heap.allocate();
    const auto garbage = heap.allocate();
    heap.setField(first, "next", second);
    heap.setField(second, "next", third);
    heap.setField(third, "shared", second);
    heap.setField(garbage, "self", garbage);
    heap.setRoot("first", first);
    heap.setRoot("fourth", fourth);

    heap.collect();
    heap.verifyInvariants();

    CHECK_EQ(observer.begun.size(), 1U);
    CHECK_EQ(observer.begun.front(), 1U);
    CHECK_EQ(observer.visits.size(), 4U);
    CHECK_EQ(observer.view.objects().size(), 5U);
    CHECK_EQ(observer.freed.size(), 1U);
    CHECK_EQ(observer.freed.front(), garbage);
    CHECK_EQ(observer.ended.size(), 1U);
    CHECK_EQ(observer.ended.front().freed, 1U);

    std::unordered_map<std::size_t, const memory::HeapObjectView*> objects;
    for (const auto& object : observer.view.objects()) {
        objects.emplace(object.handle.raw(), &object);
    }
    std::unordered_map<std::string, gc::ObjectHandle> roots;
    for (const auto& root : observer.view.roots()) {
        roots.emplace(root.name, root.target);
    }
    std::size_t marked = 0;
    for (const auto& entry : objects) {
        const memory::HeapObjectView& object = *entry.second;
        if (!object.marked) {
            CHECK(!object.discoveredBy);
            continue;
        }
        ++marked;
        CHECK(object.discoveredBy);
        const memory::MarkDiscovery& discovery = *object.discoveredBy;
        if (discovery.parent) {
            CHECK(discovery.field);
            const auto parent = objects.find(discovery.parent->raw());
            CHECK(parent != objects.end());
            bool edgeFound = false;
            for (const auto& field : parent->second->fields) {
                edgeFound = edgeFound ||
                            (field.name == *discovery.field && field.target == object.handle);
            }
            CHECK(edgeFound);
        } else {
            CHECK(discovery.root);
            const auto root = roots.find(*discovery.root);
            CHECK(root != roots.end());
            CHECK_EQ(root->second, object.handle);
        }
        CHECK_EQ(object.allocStatement, 42U);
    }
    CHECK_EQ(marked, 4U);
}

std::vector<std::size_t> freedHandles(const memory::Heap& heap,
                                      const std::vector<gc::ObjectHandle>& allocated) {
    std::vector<std::size_t> live;
    const memory::HeapView view = heap.view();
    for (const auto& object : view.objects()) {
        live.push_back(object.handle.raw());
    }
    std::vector<std::size_t> freed;
    for (const auto handle : allocated) {
        if (std::find(live.begin(), live.end(), handle.raw()) == live.end()) {
            freed.push_back(handle.raw());
        }
    }
    return freed;
}

void testObserverDoesNotChangeFreedObjects() {
    memory::Heap plain;
    memory::Heap observed;
    RecordingObserver observer;
    observed.setObserver(&observer);
    std::vector<gc::ObjectHandle> plainHandles;
    std::vector<gc::ObjectHandle> observedHandles;
    for (std::size_t i = 0; i < 6; ++i) {
        plainHandles.push_back(plain.allocate());
        observedHandles.push_back(observed.allocate());
    }
    plain.setField(plainHandles[0], "child", plainHandles[1]);
    observed.setField(observedHandles[0], "child", observedHandles[1]);
    plain.setField(plainHandles[2], "cycle", plainHandles[3]);
    plain.setField(plainHandles[3], "cycle", plainHandles[2]);
    observed.setField(observedHandles[2], "cycle", observedHandles[3]);
    observed.setField(observedHandles[3], "cycle", observedHandles[2]);
    plain.setRoot("live", plainHandles[0]);
    observed.setRoot("live", observedHandles[0]);

    plain.collect();
    observed.collect();

    CHECK_EQ(freedHandles(plain, plainHandles), freedHandles(observed, observedHandles));
    CHECK_EQ(plain.diagnostics().collections.back().freed,
             observed.diagnostics().collections.back().freed);
}

} // namespace

int main() {
    testFiveObjectGraphCounters();
    testOneLiveObjectAfterOneMillionGarbageSlots();
    testFieldNodeAccounting();
    testMarkForestObserverAndHeapView();
    testObserverDoesNotChangeFreedObjects();
    std::cout << "diagnostics_tests: all checks passed\n";
}
