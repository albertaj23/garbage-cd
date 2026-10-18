#include "check.hpp"

#include <cerrno>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <vector>

#include "memory/heap.hpp"
#include "random_ops.hpp"

namespace {

std::uint64_t seedCount() {
    const char* value = std::getenv("GCD_REGION_SEEDS");
    return value == nullptr || *value == '\0' ? 300 : std::strtoull(value, nullptr, 10);
}

const memory::RegionInfo& regionById(const memory::RegionGraph& graph, std::uint64_t id) {
    CHECK(id < graph.regions.size());
    return graph.regions[id];
}

std::uint64_t crossCount(const memory::RegionGraph& graph, std::uint64_t from, std::uint64_t to) {
    for (const auto& edge : graph.edges) {
        if (edge.from == from && edge.to == to) {
            return edge.count;
        }
    }
    return 0;
}

void testSmallScenario() {
    memory::Heap::Options options;
    options.regionSize = 2;
    memory::Heap heap(options);
    const auto a = heap.allocate();  // slot 0, region 0
    const auto b = heap.allocate();  // slot 1, region 0
    const auto c = heap.allocate();  // slot 2, region 1
    heap.setRoot("a", a);
    heap.setField(a, "b", b);        // intra edge in region 0
    heap.setField(a, "c", c);        // cross edge 0 -> 1
    heap.setField(c, "back", a);     // cross edge 1 -> 0
    heap.verifyRegions();

    auto graph = heap.regionGraph();
    CHECK(graph.verified);
    CHECK_EQ(graph.regionSize, 2U);
    CHECK_EQ(graph.regions.size(), 2U);
    CHECK_EQ(regionById(graph, 0).stats.liveObjects, 2U);
    CHECK_EQ(regionById(graph, 0).stats.intraEdges, 1U);
    CHECK_EQ(regionById(graph, 0).slotStart, 0U);
    CHECK_EQ(regionById(graph, 0).slotEnd, 1U);
    CHECK_EQ(regionById(graph, 0).rootTargets, 1U);
    CHECK_EQ(regionById(graph, 1).rootTargets, 0U);
    CHECK_EQ(crossCount(graph, 0, 1), 1U);
    CHECK_EQ(crossCount(graph, 1, 0), 1U);

    // Overwriting a field moves the edge; setting null removes it.
    heap.setField(a, "c", b);
    graph = heap.regionGraph();
    CHECK_EQ(crossCount(graph, 0, 1), 0U);
    CHECK_EQ(regionById(graph, 0).stats.intraEdges, 2U);
    heap.setField(a, "c", gc::ObjectHandle::invalid());
    heap.verifyRegions();

    // Dropping the root frees all three; every counter returns to zero.
    heap.clearRoot("a");
    heap.collect();
    graph = heap.regionGraph();
    CHECK(graph.verified);
    CHECK_EQ(regionById(graph, 0).stats.liveObjects, 0U);
    CHECK_EQ(regionById(graph, 0).stats.freedLastGc, 2U);
    CHECK_EQ(regionById(graph, 1).stats.freedLastGc, 1U);
    CHECK_EQ(regionById(graph, 0).stats.allocatedTotal, 2U);
    CHECK_EQ(regionById(graph, 0).stats.survivorsLastGc, 0U);
    CHECK(graph.edges.empty());
    CHECK_EQ(regionById(graph, 0).stats.intraEdges, 0U);
}

void testSurvivorsAndFreedPerCollection() {
    memory::Heap::Options options;
    options.regionSize = 4;
    memory::Heap heap(options);
    std::vector<gc::ObjectHandle> objects;
    for (int i = 0; i < 8; ++i) {
        objects.push_back(heap.allocate());
    }
    heap.setRoot("keep", objects[1]);
    heap.setRoot("keep2", objects[5]);
    heap.collect();
    auto graph = heap.regionGraph();
    CHECK_EQ(regionById(graph, 0).stats.survivorsLastGc, 1U);
    CHECK_EQ(regionById(graph, 0).stats.freedLastGc, 3U);
    CHECK_EQ(regionById(graph, 1).stats.survivorsLastGc, 1U);
    heap.collect();  // nothing new freed: freedLastGc resets
    graph = heap.regionGraph();
    CHECK_EQ(regionById(graph, 0).stats.freedLastGc, 0U);
    CHECK_EQ(regionById(graph, 0).stats.allocatedTotal, 4U);
}

void testStaleWriteIsStoredAsNullAndKeepsCounters() {
    for (const bool reuse : {false, true}) {
        memory::Heap::Options options;
        options.regionSize = 4;
        options.slotReuse = reuse;
        memory::Heap heap(options);
        const auto victim = heap.allocate();
        const auto holder = heap.allocate();
        heap.setRoot("holder", holder);
        heap.collect();  // frees victim
        heap.setField(holder, "dangling", victim);
        CHECK(heap.getField(holder, "dangling") == gc::ObjectHandle::invalid());
        CHECK_EQ(heap.diagnostics().staleWritesRejected, 1U);
        heap.verifyRegions();
        heap.verifyInvariants();
    }
}

void testDisabledAndInvalidSizes() {
    memory::Heap off;
    off.allocate();
    CHECK(off.regionGraph().regions.empty());
    off.verifyRegions();
    bool threw = false;
    try {
        memory::Heap::Options options;
        options.regionSize = 48;
        memory::Heap bad(options);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);
}

void testSnapshotViewCarriesRegionAndGeneration() {
    memory::Heap::Options options;
    options.regionSize = 4;
    options.slotReuse = true;
    memory::Heap heap(options);
    for (int i = 0; i < 6; ++i) {
        heap.allocate();
    }
    const auto view = heap.view();
    CHECK_EQ(view.objects().size(), 6U);
    CHECK_EQ(view.objects()[5].slot, 5U);
    CHECK_EQ(view.objects()[5].generation, 1U);
    CHECK(view.objects()[5].region.has_value());
    CHECK_EQ(*view.objects()[5].region, 1U);
    CHECK_EQ(*view.objects()[3].region, 0U);
}

// G.1 row 13: counters equal a from-scratch recomputation after every operation.
void testRandomProgramsAfterEveryOperation() {
    const std::uint64_t seeds = seedCount();
    for (std::uint64_t seed = 1; seed <= seeds; ++seed) {
        for (const std::uint32_t size : {1U, 16U, 64U, 256U}) {
            for (const bool reuse : {false, true}) {
                memory::Heap::Options options;
                options.regionSize = size;
                options.slotReuse = reuse;
                memory::Heap heap(options);
                std::vector<gc::ObjectHandle> handles;
                for (const auto& op : testops::generateOps(seed * 31 + size, 60, 400)) {
                    testops::apply(heap, handles, op);
                    heap.verifyRegions();
                }
                heap.collect();  // I5 is only defined right after a collection
                heap.verifyInvariants();
            }
        }
    }
}

} // namespace

int main() {
    testSmallScenario();
    testSurvivorsAndFreedPerCollection();
    testStaleWriteIsStoredAsNullAndKeepsCounters();
    testDisabledAndInvalidSizes();
    testSnapshotViewCarriesRegionAndGeneration();
    testRandomProgramsAfterEveryOperation();
    std::cout << "region_tests: passed (" << seedCount() << " seeds x 8 configurations)\n";
}
