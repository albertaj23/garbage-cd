#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "interpreter/ast.hpp"
#include "spans.hpp"

std::string writeToyAstJson(const interpreter::Program& program,
                            const std::vector<SourceSpan>& spans,
                            std::uint64_t& nodeCount, bool& truncated);
