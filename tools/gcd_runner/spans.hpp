#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct SourceSpan {
    std::uint64_t start = 0;
    std::uint64_t end = 0;
    std::uint64_t line = 1;
    std::uint64_t column = 1;
    std::uint64_t endLine = 1;
    std::uint64_t endColumn = 1;
};

std::vector<SourceSpan> deriveStatementSpans(const std::string& source,
                                             std::size_t statementCount);
