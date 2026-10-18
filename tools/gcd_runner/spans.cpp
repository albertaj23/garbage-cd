#include "spans.hpp"

#include <cctype>
#include <stdexcept>

namespace {

std::pair<std::uint64_t, std::uint64_t> lineColumnAt(const std::string& source,
                                                    std::size_t offset) {
    std::uint64_t line = 1;
    std::uint64_t column = 1;
    for (std::size_t i = 0; i < offset; ++i) {
        if (source[i] == '\n') {
            ++line;
            column = 1;
        } else {
            ++column;
        }
    }
    return {line, column};
}

} // namespace

std::vector<SourceSpan> deriveStatementSpans(const std::string& source,
                                             std::size_t statementCount) {
    std::vector<SourceSpan> spans;
    spans.reserve(statementCount);
    std::size_t previousEnd = 0;

    for (std::size_t i = 0; i < statementCount; ++i) {
        const std::size_t semicolon = source.find(';', previousEnd);
        if (semicolon == std::string::npos) {
            throw std::runtime_error("statement span count does not match the parsed program");
        }

        std::size_t start = previousEnd;
        while (start < semicolon &&
               std::isspace(static_cast<unsigned char>(source[start]))) {
            ++start;
        }
        const std::size_t end = semicolon + 1;
        const auto startPosition = lineColumnAt(source, start);
        const auto endPosition = lineColumnAt(source, end);
        spans.push_back(SourceSpan{start, end, startPosition.first, startPosition.second,
                                   endPosition.first, endPosition.second});
        previousEnd = end;
    }

    if (source.find(';', previousEnd) != std::string::npos) {
        throw std::runtime_error("parsed program omitted one or more statement spans");
    }
    return spans;
}
