#pragma once

#include <cstdint>
#include <vector>

namespace memory {

struct CollectionRecord {
    std::uint64_t gcIndex = 0;
    std::uint64_t liveBefore = 0;
    std::uint64_t marked = 0;
    std::uint64_t freed = 0;
    std::uint64_t liveAfter = 0;
    std::uint64_t fieldsScanned = 0;
    std::uint64_t refsPushed = 0;
    std::uint64_t worklistPeak = 0;
    std::uint64_t slotsScanned = 0;
    std::uint64_t fieldNodesFreed = 0;
    std::uint64_t markNs = 0;
    std::uint64_t sweepNs = 0;
    std::uint64_t totalNs = 0;
};

struct GcDiagnostics {
    std::vector<CollectionRecord> collections;
    std::uint64_t currentFieldNodes = 0;
    // Field writes whose target was a valid handle that no longer resolves; stored as null.
    std::uint64_t staleWritesRejected = 0;
    // Slots permanently retired because their generation reached the limit (slot reuse only).
    std::uint64_t slotsRetired = 0;
};

} // namespace memory
