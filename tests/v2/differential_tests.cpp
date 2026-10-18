#include "check.hpp"

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <set>
#include <vector>

#include "memory/heap.hpp"
#include "random_ops.hpp"

namespace {

std::uint64_t seedCount() {
    const char* value = std::getenv("GCD_DIFFERENTIAL_SEEDS");
    return value == nullptr || *value == '\0' ? 200 : std::strtoull(value, nullptr, 10);
}

struct Run {
    testops::Variant variant;
    std::unique_ptr<memory::Heap> heap;
    std::unique_ptr<testops::NullObserver> observer = std::make_unique<testops::NullObserver>();
    std::vector<gc::ObjectHandle> handles;
    std::vector<std::set<std::uint64_t>> freedPerCollection;
    std::vector<std::uint64_t> liveAfter;
};

std::set<std::uint64_t> liveAllocSeqs(const memory::Heap& heap) {
    std::set<std::uint64_t> result;
    const auto view = heap.view();  // the view must outlive the loop over its objects
    for (const auto& object : view.objects()) {
        result.insert(object.allocSeq);
    }
    return result;
}

// G.1 row 15 / I9 / H5: the freed allocSeq set of every collection is identical in every variant.
void testIdenticalFreedSets() {
    const std::uint64_t seeds = seedCount();
    for (std::uint64_t seed = 1; seed <= seeds; ++seed) {
        const auto ops = testops::generateOps(seed * 7919);
        std::vector<Run> runs;
        for (const auto& variant : testops::allVariants()) {
            Run run;
            run.variant = variant;
            run.heap = std::make_unique<memory::Heap>(variant.options);
            if (variant.observer) {
                run.heap->setObserver(run.observer.get());  // heap-allocated: Run is moved below
            }
            runs.push_back(std::move(run));
        }
        for (const auto& op : ops) {
            for (auto& run : runs) {
                std::set<std::uint64_t> before;
                if (op.kind == testops::Kind::Collect) {
                    before = liveAllocSeqs(*run.heap);
                }
                testops::apply(*run.heap, run.handles, op);
                if (op.kind == testops::Kind::Collect) {
                    const auto after = liveAllocSeqs(*run.heap);
                    std::set<std::uint64_t> freed;
                    std::set_difference(before.begin(), before.end(), after.begin(), after.end(),
                                        std::inserter(freed, freed.begin()));
                    run.freedPerCollection.push_back(std::move(freed));
                    run.liveAfter.push_back(run.heap->getStats().liveObjectsAfterLastRun);
                }
            }
        }
        for (auto& run : runs) {
            run.heap->collect();  // I5 is only defined right after a collection
            run.heap->verifyInvariants();
        }
        const Run& baseline = runs.front();
        for (const auto& run : runs) {
            CHECK(run.freedPerCollection == baseline.freedPerCollection);
            CHECK(run.liveAfter == baseline.liveAfter);
            CHECK_EQ(run.heap->getStats().totalAllocations, baseline.heap->getStats().totalAllocations);
            CHECK(liveAllocSeqs(*run.heap) == liveAllocSeqs(*baseline.heap));
        }
    }
}

} // namespace

int main() {
    testIdenticalFreedSets();
    std::cout << "differential_tests: " << seedCount() << " seeds x "
              << testops::allVariants().size() << " variants passed\n";
}
