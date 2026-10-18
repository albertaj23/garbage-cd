#include "memory/heap.hpp"

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <unordered_set>

namespace memory {

static_assert(sizeof(std::size_t) == 8, "slot-reuse handle encoding needs 64-bit size_t");

Heap::Heap(const Options& options) : options_(options), regions_(options.regionSize) {
    const std::uint32_t size = options.regionSize;
    if (size != 0 && (size & (size - 1)) != 0) {
        throw std::invalid_argument("Heap: region size must be 0 or a power of two");
    }
}

gc::ObjectHandle Heap::allocate() {
    auto object = std::make_unique<Object>();
    object->allocSeq = stats_.totalAllocations + 1;
    object->allocStatement = currentStatement_;
    std::size_t slot;
    if (options_.slotReuse && !freeSlots_.empty()) {
        slot = freeSlots_.back();
        freeSlots_.pop_back();
        objects_[slot] = std::move(object);
        slotInUse_[slot] = true;
    } else {
        if (objects_.size() >= 0xFFFFFFFEull) {
            throw std::length_error("Heap: slot index space exhausted");
        }
        slot = objects_.size();
        objects_.push_back(std::move(object));
        slotInUse_.push_back(true);
        if (options_.slotReuse) {
            generations_.push_back(1);
        }
    }
    stats_.totalAllocations++;
    if (slot < discoveries_.size()) {
        discoveries_[slot].reset();  // do not show a previous occupant's discovery
    }
    if (regions_.enabled()) {
        regions_.onAllocate(slot);
    }
    return handleFor(slot);
}

void Heap::setRoot(const std::string& name, gc::ObjectHandle handle) {
    roots_[name] = resolve(handle) == nullptr ? gc::ObjectHandle::invalid() : handle;
}

void Heap::clearRoot(const std::string& name) {
    roots_.erase(name);
}

void Heap::setField(gc::ObjectHandle obj, const std::string& field, gc::ObjectHandle target) {
    Object* object = resolve(obj);
    if (object != nullptr) {
        // Reference-integrity hardening (E.3): a valid handle that no longer resolves is
        // stored as null. mark() already ignored such handles, so reachability is unchanged.
        if (target.isValid() && resolve(target) == nullptr) {
            target = gc::ObjectHandle::invalid();
            ++diagnostics_.staleWritesRejected;
        }
        if (regions_.enabled()) {
            // Write barrier: keep region edge counts equal to the live reference fields.
            const gc::ObjectHandle previous = object->getField(field);
            if (previous.isValid()) {
                regions_.onEdgeRemoved(slotOf(obj), slotOf(previous));
            }
            if (target.isValid()) {
                regions_.onEdgeAdded(slotOf(obj), slotOf(target));
            }
        }
        const bool isNewField = object->fields().find(field) == object->fields().end();
        object->setField(field, target);
        if (isNewField) {
            ++diagnostics_.currentFieldNodes;
        }
    }
}

gc::ObjectHandle Heap::getField(gc::ObjectHandle obj, const std::string& field) const {
    Object* object = resolve(obj);
    if (object == nullptr) {
        return gc::ObjectHandle::invalid();
    }
    return object->getField(field);
}

void Heap::collect() {
    CollectionRecord record;
    record.gcIndex = stats_.totalCollections + 1;
    const auto start = std::chrono::steady_clock::now();
    if (observer_) {
        observer_->onCollectionBegin(record.gcIndex);
    }
    if (regions_.enabled()) {
        regions_.beginCollection();
    }
    mark(record);
    if (observer_) {
        observer_->onMarkComplete(makeView());
    }
    sweep(record);
    if (regions_.enabled()) {
        regions_.endCollection();
    }
    record.totalNs = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - start)
            .count());
    diagnostics_.collections.push_back(record);
    stats_.totalCollections++;
    if (observer_) {
        observer_->onCollectionEnd(diagnostics_.collections.back());
    }
#ifndef NDEBUG
    verifyInvariants();
#endif
}

gc::GCStats Heap::getStats() const {
    return stats_;
}

const GcDiagnostics& Heap::diagnostics() const {
    return diagnostics_;
}

void Heap::setObserver(GcObserver* observer) {
    observer_ = observer;
}

void Heap::setCurrentStatement(std::uint32_t statementIndex) {
    currentStatement_ = statementIndex;
}

HeapView Heap::view() const {
    return makeView();
}

HeapView Heap::makeView() const {
    HeapView view;
    view.objects_.reserve(stats_.liveObjectsAfterLastRun);
    for (std::size_t i = 0; i < objects_.size(); ++i) {
        if (!slotInUse_[i] || objects_[i] == nullptr) {
            continue;
        }
        const Object& object = *objects_[i];
        HeapObjectView objectView;
        objectView.handle = handleFor(i);
        objectView.slot = i;
        objectView.generation = options_.slotReuse ? generations_[i] : 0;
        if (regions_.enabled()) {
            objectView.region = regions_.regionOf(i);
        }
        objectView.allocSeq = object.allocSeq;
        objectView.allocStatement = object.allocStatement;
        objectView.marked = object.marked;
        if (i < discoveries_.size()) {
            objectView.discoveredBy = discoveries_[i];
        }
        objectView.fields.reserve(object.fields().size());
        for (const auto& field : object.fields()) {
            objectView.fields.push_back(HeapFieldView{field.first, field.second});
        }
        std::sort(objectView.fields.begin(), objectView.fields.end(),
                  [](const HeapFieldView& left, const HeapFieldView& right) {
                      return left.name < right.name;
                  });
        view.objects_.push_back(std::move(objectView));
    }

    view.roots_.reserve(roots_.size());
    for (const auto& root : roots_) {
        if (root.second.isValid()) {
            view.roots_.push_back(HeapRootView{root.first, root.second});
        }
    }
    std::sort(view.roots_.begin(), view.roots_.end(),
              [](const HeapRootView& left, const HeapRootView& right) {
                  return left.name < right.name;
              });
    return view;
}

void Heap::verifyInvariants() const {
    const auto fail = [](const char* message) {
        throw std::logic_error(std::string("Heap invariant failed: ") + message);
    };

    for (const auto& root : roots_) {
        if (root.second.isValid() && resolve(root.second) == nullptr) {
            fail("I1 root handle does not resolve");
        }
    }
    verifyRegions();
    if (options_.slotReuse) {
        std::unordered_set<std::size_t> seen;
        for (const std::size_t slot : freeSlots_) {
            if (slot >= objects_.size() || slotInUse_[slot] || !seen.insert(slot).second) {
                fail("I8 free list holds an in-use, unknown, or duplicate slot");
            }
        }
    }
    // I4: every stored reference field of an in-use object resolves.
    for (std::size_t i = 0; i < objects_.size(); ++i) {
        if (!slotInUse_[i] || objects_[i] == nullptr) {
            continue;
        }
        for (const auto& field : objects_[i]->fields()) {
            if (field.second.isValid() && resolve(field.second) == nullptr) {
                fail("I4 field target does not resolve");
            }
        }
    }

    std::uint64_t inUseCount = 0;
    for (std::size_t i = 0; i < objects_.size(); ++i) {
        if (slotInUse_[i] && objects_[i] != nullptr) {
            ++inUseCount;
        }
    }

    if (stats_.totalCollections == 0) {
        if (diagnostics_.collections.size() != 0) {
            fail("diagnostic collection count is inconsistent");
        }
        return;
    }

    if (diagnostics_.collections.size() != stats_.totalCollections) {
        fail("diagnostic collection count is inconsistent");
    }

    for (const auto& object : objects_) {
        if (object != nullptr && object->marked) {
            fail("I3 mark bit remains set after collection");
        }
    }

    std::uint64_t freedTotal = 0;
    for (const auto& record : diagnostics_.collections) {
        freedTotal += record.freed;
    }
    if (stats_.liveObjectsAfterLastRun != inUseCount ||
        stats_.totalAllocations < freedTotal ||
        stats_.totalAllocations - freedTotal != inUseCount) {
        fail("I5 allocation, freed, and live counts disagree");
    }

    std::unordered_set<std::size_t> reachable;
    std::vector<gc::ObjectHandle> worklist;
    for (const auto& root : roots_) {
        if (root.second.isValid()) {
            worklist.push_back(root.second);
        }
    }
    while (!worklist.empty()) {
        const gc::ObjectHandle handle = worklist.back();
        worklist.pop_back();
        Object* object = resolve(handle);
        if (object == nullptr || !reachable.insert(slotOf(handle)).second) {
            continue;
        }
        for (const auto& field : object->fields()) {
            if (field.second.isValid()) {
                worklist.push_back(field.second);
            }
        }
    }

    for (std::size_t i = 0; i < objects_.size(); ++i) {
        const bool inUse = slotInUse_[i] && objects_[i] != nullptr;
        if (inUse != (reachable.find(i) != reachable.end())) {
            fail("I2 in-use objects differ from root reachability");
        }
    }

    if (!observer_ || !observer_->wantsMarkForest()) {
        return;
    }
    for (std::size_t i = 0; i < objects_.size(); ++i) {
        if (!slotInUse_[i] || objects_[i] == nullptr) {
            continue;
        }
        const auto discoveryOf = [this](std::size_t slot) -> const std::optional<MarkDiscovery>& {
            static const std::optional<MarkDiscovery> none;
            return slot < discoveries_.size() ? discoveries_[slot] : none;
        };
        if (!discoveryOf(i)) {
            fail("I7 live object has no mark-forest discoverer");
        }
        std::unordered_set<std::size_t> path;
        std::size_t currentSlot = i;
        while (discoveryOf(currentSlot) && discoveryOf(currentSlot)->parent) {
            if (!path.insert(currentSlot).second) {
                fail("I7 mark-forest contains a cycle");
            }
            const MarkDiscovery& discovery = *discoveryOf(currentSlot);
            if (!discovery.field || discovery.root) {
                fail("I7 parent discovery has invalid edge metadata");
            }
            const Object* parent = resolve(*discovery.parent);
            if (parent == nullptr || parent->getField(*discovery.field) !=
                                         handleFor(currentSlot)) {
                fail("I7 parent discovery is not a real field edge");
            }
            currentSlot = slotOf(*discovery.parent);
        }
        const auto& terminal = discoveryOf(currentSlot);
        if (!terminal || !terminal->root || terminal->parent || terminal->field) {
            fail("I7 mark-forest path does not terminate at a root");
        }
        const auto root = roots_.find(*terminal->root);
        if (root == roots_.end() || root->second != handleFor(currentSlot)) {
            fail("I7 root discovery is not a real root edge");
        }
    }
}

std::size_t Heap::slotOf(gc::ObjectHandle handle) const {
    return options_.slotReuse ? static_cast<std::size_t>(handle.raw() & 0xFFFFFFFFull)
                              : handle.raw();
}

gc::ObjectHandle Heap::handleFor(std::size_t slot) const {
    if (!options_.slotReuse) {
        return gc::ObjectHandle(slot);
    }
    return gc::ObjectHandle((static_cast<std::size_t>(generations_[slot]) << 32) | slot);
}

Object* Heap::resolve(gc::ObjectHandle handle) const {
    if (!handle.isValid()) {
        return nullptr;
    }
    const std::size_t slot = slotOf(handle);
    if (slot >= objects_.size() || !slotInUse_[slot]) {
        return nullptr;
    }
    if (options_.slotReuse && (handle.raw() >> 32) != generations_[slot]) {
        return nullptr;
    }
    return objects_[slot].get();
}

void Heap::setGenerationLimitForTesting(std::uint32_t limit) {
    generationLimit_ = limit;
}

void Heap::verifyRegions() const {
    if (!regions_.enabled()) {
        return;
    }
    const auto fail = [](const char* message) {
        throw std::logic_error(std::string("Heap invariant failed: ") + message);
    };
    std::vector<std::uint64_t> live;
    std::vector<std::uint64_t> intra;
    std::unordered_map<std::uint64_t, std::uint32_t> cross;
    const auto grow = [&](std::size_t region) {
        if (region >= live.size()) {
            live.resize(region + 1, 0);
            intra.resize(region + 1, 0);
        }
    };
    for (std::size_t i = 0; i < objects_.size(); ++i) {
        if (!slotInUse_[i] || objects_[i] == nullptr) {
            continue;
        }
        const std::size_t from = regions_.regionOf(i);
        grow(from);
        ++live[from];
        for (const auto& field : objects_[i]->fields()) {
            if (!field.second.isValid()) {
                continue;
            }
            const std::size_t to = regions_.regionOf(slotOf(field.second));
            grow(to);
            if (from == to) {
                ++intra[from];
            } else {
                ++cross[RegionTable::key(from, to)];
            }
        }
    }
    const auto& table = regions_.regions();
    const std::size_t count = std::max(table.size(), live.size());
    for (std::size_t region = 0; region < count; ++region) {
        const std::uint64_t tableLive = region < table.size() ? table[region].liveObjects : 0;
        const std::uint64_t tableIntra = region < table.size() ? table[region].intraEdges : 0;
        const std::uint64_t expectedLive = region < live.size() ? live[region] : 0;
        const std::uint64_t expectedIntra = region < intra.size() ? intra[region] : 0;
        if (tableLive != expectedLive) {
            fail("I6 region live-object count differs from recomputation");
        }
        if (tableIntra != expectedIntra) {
            fail("I6 region intra-edge count differs from recomputation");
        }
        if (region < table.size() && table[region].allocatedTotal < table[region].liveObjects) {
            fail("I6 region allocated total is below its live count");
        }
    }
    if (cross != regions_.crossEdges()) {
        fail("I6 cross-region edge counts differ from recomputation");
    }
}

RegionGraph Heap::regionGraph(bool verify) const {
    RegionGraph graph;
    if (!regions_.enabled()) {
        return graph;
    }
    graph.regionSize = regions_.regionSize();
    if (verify) {
        try {
            verifyRegions();
            graph.verified = true;
        } catch (const std::logic_error&) {
            graph.verified = false;
        }
    }
    const auto& table = regions_.regions();
    std::vector<std::uint64_t> rootTargets(table.size(), 0);
    for (const auto& root : roots_) {
        if (root.second.isValid() && resolve(root.second) != nullptr) {
            const std::size_t region = regions_.regionOf(slotOf(root.second));
            if (region < rootTargets.size()) {
                ++rootTargets[region];
            }
        }
    }
    for (std::size_t region = 0; region < table.size(); ++region) {
        RegionInfo info;
        info.id = region;
        info.slotStart = static_cast<std::uint64_t>(region) * regions_.regionSize();
        info.slotEnd = info.slotStart + regions_.regionSize() - 1;
        info.stats = table[region];
        info.rootTargets = rootTargets[region];
        graph.regions.push_back(info);
    }
    for (const auto& edge : regions_.crossEdges()) {
        graph.edges.push_back(RegionEdge{edge.first >> 32, edge.first & 0xFFFFFFFFull, edge.second});
    }
    std::sort(graph.edges.begin(), graph.edges.end(), [](const RegionEdge& a, const RegionEdge& b) {
        return a.from != b.from ? a.from < b.from : a.to < b.to;
    });
    return graph;
}

// Heap::mark() is defined in mark.cpp.
// Heap::sweep() is defined in sweep.cpp.

} // namespace memory
