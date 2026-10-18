#pragma once

#include <algorithm>
#include <optional>
#include <string>

#include "spans.hpp"

struct RunnerError {
    std::string code;
    std::string phase;
    std::string message;
    std::optional<SourceSpan> location;
};

inline RunnerError classifyRunnerError(const std::string& message,
                                       const std::string& phase,
                                       const std::optional<SourceSpan>& span = std::nullopt) {
    RunnerError error{"RUNTIME_ERROR", phase, message, std::nullopt};
    if (message.rfind("Lexer:", 0) == 0) {
        error.code = "LEX_ERROR";
        error.location.reset();
    } else if (message.rfind("Parser:", 0) == 0) {
        error.code = "PARSE_ERROR";
        error.location.reset();
    } else if (message.rfind("Interpreter:", 0) == 0) {
        error.code = "RUNTIME_ERROR";
        error.location = span;
    }
    if (error.message.size() > 2000) {
        error.message.resize(2000);
    }
    return error;
}
