#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "memory/region_table.hpp"

struct RegionGraphRecord {
    std::uint64_t index = 0;
    std::optional<std::uint64_t> gcIndex;
    std::string point;  // "gc_end" (after sweep) or "program_end"
    std::uint64_t regionCount = 0;
    bool verified = false;
};

// Writes `gcd.region-graph/1` documents (one file per collection plus one at program end).
class RegionGraphWriter {
public:
    RegionGraphWriter(std::string directory, std::string runId);

    RegionGraphRecord write(const std::string& point, const memory::RegionGraph& graph,
                            std::optional<std::uint64_t> gcIndex, std::uint32_t statementIndex);
    std::string serialize(const std::string& point, const memory::RegionGraph& graph,
                          std::optional<std::uint64_t> gcIndex, std::uint32_t statementIndex,
                          std::uint64_t index) const;

    const std::vector<RegionGraphRecord>& records() const { return records_; }
    const std::string& error() const { return error_; }

private:
    std::string directory_;
    std::string runId_;
    std::uint64_t nextIndex_ = 0;
    std::vector<RegionGraphRecord> records_;
    std::string error_;
};
