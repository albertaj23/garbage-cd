#include "check.hpp"

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <queue>
#include <random>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "gc_interface.hpp"
#include "memory/heap.hpp"
#include "random_ops.hpp"

namespace {

struct ModelObject {
    bool alive = true;
    std::unordered_map<std::string, std::size_t> fields;
};

using ObjectMap = std::unordered_map<std::size_t, ModelObject>;
using RootMap = std::unordered_map<std::string, std::size_t>;

std::unordered_set<std::size_t> reachableObjects(const ObjectMap& objects,
                                                 const RootMap& roots) {
    std::unordered_set<std::size_t> reachable;
    std::queue<std::size_t> worklist;
    for (const auto& root : roots) {
        worklist.push(root.second);
    }

    while (!worklist.empty()) {
        const std::size_t id = worklist.front();
        worklist.pop();
        const auto object = objects.find(id);
        if (object == objects.end() || !object->second.alive ||
            !reachable.insert(id).second) {
            continue;
        }
        for (const auto& field : object->second.fields) {
            if (field.second != std::numeric_limits<std::size_t>::max()) {
                worklist.push(field.second);
            }
        }
    }
    return reachable;
}

std::uint64_t seedCountFromEnvironment() {
    const char* value = std::getenv("GCD_PROPERTY_SEEDS");
    if (value == nullptr || *value == '\0') {
        return 1000;
    }

    errno = 0;
    char* end = nullptr;
    const unsigned long long parsed = std::strtoull(value, &end, 10);
    CHECK(errno == 0);
    CHECK(end != value);
    CHECK(*end == '\0');
    CHECK(parsed > 0);
    return static_cast<std::uint64_t>(parsed);
}

std::size_t choose(std::mt19937_64& rng, std::size_t upperBound) {
    CHECK(upperBound > 0);
    return static_cast<std::size_t>(rng() % upperBound);
}

void runSeed(std::uint64_t seed, const testops::Variant& variant) {
    std::mt19937_64 rng(seed);
    memory::Heap concrete(variant.options);
    testops::NullObserver observer;
    if (variant.observer) {
        concrete.setObserver(&observer);
    }
    gc::IHeap& heap = concrete;
    ObjectMap objects;
    RootMap roots;
    std::vector<gc::ObjectHandle> handles;
    const std::size_t operationCount = 200 + choose(rng, 1801);
    std::size_t collectionCount = 0;
    std::size_t freedTotal = 0;

    for (std::size_t op = 0; op < operationCount; ++op) {
        // I6 after every operation for the first 200 seeds, and every 16th operation otherwise.
        if (op > 0 && variant.options.regionSize != 0 && (seed <= 200 || op % 16 == 0)) {
            concrete.verifyRegions();
        }
        const std::size_t kind = choose(rng, 5);
        if (kind == 0 || handles.empty()) {
            const gc::ObjectHandle handle = heap.allocate();
            heap.setField(handle, "__self", handle);
            objects.emplace(handle.raw(), ModelObject{});
            objects.at(handle.raw()).fields.emplace("__self", handle.raw());
            handles.push_back(handle);
        } else if (kind == 1) {
            const std::string name = "root-" + std::to_string(choose(rng, 12));
            const gc::ObjectHandle handle = handles[choose(rng, handles.size())];
            heap.setRoot(name, handle);
            roots[name] = handle.raw();
        } else if (kind == 2) {
            const std::string name = "root-" + std::to_string(choose(rng, 12));
            heap.clearRoot(name);
            roots.erase(name);
        } else if (kind == 3) {
            const gc::ObjectHandle source = handles[choose(rng, handles.size())];
            const gc::ObjectHandle target =
                choose(rng, 8) == 0
                    ? gc::ObjectHandle::invalid()
                    : handles[choose(rng, handles.size())];
            const std::string field = "field-" + std::to_string(choose(rng, 8));
            heap.setField(source, field, target);
            auto sourceModel = objects.find(source.raw());
            if (sourceModel != objects.end() && sourceModel->second.alive) {
                sourceModel->second.fields[field] = target.raw();
            }
        } else {
            const std::unordered_set<std::size_t> reachable =
                reachableObjects(objects, roots);
            std::size_t expectedFreed = 0;
            for (auto& object : objects) {
                if (object.second.alive && reachable.count(object.first) == 0) {
                    object.second.alive = false;
                    ++expectedFreed;
                }
            }
            heap.collect();
            concrete.verifyInvariants();
            ++collectionCount;
            freedTotal += expectedFreed;

            std::unordered_set<std::size_t> actualLive;
            for (const gc::ObjectHandle handle : handles) {
                if (heap.getField(handle, "__self") == handle) {
                    actualLive.insert(handle.raw());
                }
            }
            CHECK(actualLive == reachable);

            std::size_t expectedLive = 0;
            for (const auto& object : objects) {
                if (object.second.alive) {
                    ++expectedLive;
                }
            }
            const gc::GCStats stats = heap.getStats();
            CHECK_EQ(stats.totalAllocations, objects.size());
            CHECK_EQ(stats.totalCollections, collectionCount);
            CHECK_EQ(stats.objectsCollectedLastRun, expectedFreed);
            CHECK_EQ(stats.liveObjectsAfterLastRun, expectedLive);
            CHECK_EQ(stats.totalAllocations, freedTotal + expectedLive);
        }
    }
}

} // namespace

int main() {
    const std::uint64_t seedCount = seedCountFromEnvironment();
    for (std::uint64_t seed = 0; seed < seedCount; ++seed) {
        for (const auto& variant : testops::allVariants()) {
            runSeed(seed + 1, variant);
        }
    }
    std::cout << "gc_property_tests: " << seedCount << " seeds x "
              << testops::allVariants().size() << " variants passed\n";
}
