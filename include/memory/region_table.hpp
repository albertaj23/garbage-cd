#pragma once

// memory::RegionTable -- observational region metadata (E.2, E.3).
// Header-only so it needs no change to the frozen root CMakeLists.txt.
// Nothing here influences what is marked or freed.

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace memory {

struct RegionStats {
    std::uint64_t liveObjects = 0;
    std::uint64_t allocatedTotal = 0;
    std::uint64_t survivorsLastGc = 0;
    std::uint64_t freedLastGc = 0;
    std::uint64_t intraEdges = 0;
};

struct RegionInfo {
    std::uint64_t id = 0;
    std::uint64_t slotStart = 0;
    std::uint64_t slotEnd = 0;  // inclusive: the last slot index of the region
    RegionStats stats;
    std::uint64_t rootTargets = 0;
};

struct RegionEdge {
    std::uint64_t from = 0;
    std::uint64_t to = 0;
    std::uint64_t count = 0;
};

struct RegionGraph {
    std::uint32_t regionSize = 0;
    std::vector<RegionInfo> regions;
    std::vector<RegionEdge> edges;  // cross-region only, count > 0, sorted by (from, to)
    bool verified = false;
};

class RegionTable {
public:
    explicit RegionTable(std::uint32_t regionSize = 0) : regionSize_(regionSize) {}

    bool enabled() const { return regionSize_ != 0; }
    std::uint32_t regionSize() const { return regionSize_; }
    std::size_t regionOf(std::size_t slot) const { return slot / regionSize_; }

    void onAllocate(std::size_t slot) {
        RegionStats& region = ensure(regionOf(slot));
        ++region.liveObjects;
        ++region.allocatedTotal;
    }

    void onEdgeAdded(std::size_t sourceSlot, std::size_t targetSlot) {
        const std::size_t from = regionOf(sourceSlot);
        const std::size_t to = regionOf(targetSlot);
        if (from == to) {
            ++ensure(from).intraEdges;
        } else {
            ++cross_[key(from, to)];
        }
    }

    void onEdgeRemoved(std::size_t sourceSlot, std::size_t targetSlot) {
        const std::size_t from = regionOf(sourceSlot);
        const std::size_t to = regionOf(targetSlot);
        if (from == to) {
            RegionStats& region = ensure(from);
            if (region.intraEdges == 0) {
                throw std::logic_error("RegionTable: intra-region edge underflow");
            }
            --region.intraEdges;
            return;
        }
        const auto found = cross_.find(key(from, to));
        if (found == cross_.end() || found->second == 0) {
            throw std::logic_error("RegionTable: cross-region edge underflow");
        }
        if (--found->second == 0) {
            cross_.erase(found);
        }
    }

    void onFree(std::size_t slot) {
        RegionStats& region = ensure(regionOf(slot));
        if (region.liveObjects == 0) {
            throw std::logic_error("RegionTable: live-object underflow");
        }
        --region.liveObjects;
        ++region.freedLastGc;
    }

    void beginCollection() {
        for (RegionStats& region : regions_) {
            region.freedLastGc = 0;
        }
    }

    void endCollection() {
        for (RegionStats& region : regions_) {
            region.survivorsLastGc = region.liveObjects;
        }
    }

    const std::vector<RegionStats>& regions() const { return regions_; }
    const std::unordered_map<std::uint64_t, std::uint32_t>& crossEdges() const { return cross_; }

    static std::uint64_t key(std::size_t from, std::size_t to) {
        return (static_cast<std::uint64_t>(from) << 32) | static_cast<std::uint64_t>(to);
    }

private:
    RegionStats& ensure(std::size_t region) {
        if (region >= regions_.size()) {
            regions_.resize(region + 1);
        }
        return regions_[region];
    }

    std::uint32_t regionSize_;
    std::vector<RegionStats> regions_;
    std::unordered_map<std::uint64_t, std::uint32_t> cross_;
};

} // namespace memory
