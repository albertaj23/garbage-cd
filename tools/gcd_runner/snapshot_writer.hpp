#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "memory/observer.hpp"

struct SnapshotRecord {
    std::uint64_t index = 0;
    std::optional<std::uint64_t> gcIndex;
    std::string point;
    std::uint64_t objectCount = 0;
    bool truncated = false;
    std::string path;
};

class SnapshotWriter {
public:
    SnapshotWriter(std::string directory, std::string runId,
                   std::size_t maxObjects = 2000);

    SnapshotRecord write(const std::string& point, const memory::HeapView& view,
                         std::optional<std::uint64_t> gcIndex,
                         std::uint32_t statementIndex);
    std::string serialize(const std::string& point, const memory::HeapView& view,
                          std::optional<std::uint64_t> gcIndex,
                          std::uint32_t statementIndex, std::uint64_t index,
                          bool& truncated) const;

    const std::vector<SnapshotRecord>& records() const;
    const std::string& error() const;

private:
    std::string directory_;
    std::string runId_;
    std::size_t maxObjects_;
    std::uint64_t nextIndex_ = 0;
    std::vector<SnapshotRecord> records_;
    std::string error_;
};
