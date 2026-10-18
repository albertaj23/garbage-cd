#pragma once

// runtime::Environment -- flat variable scope mapping names to Values.
// Owned by Prateek. Deliberately has no notion of nested scopes,
// functions, or closures -- the language doesn't need them.

#include <string>
#include <unordered_map>

#include "runtime/value.hpp"

namespace runtime {

class Environment {
public:
    void define(const std::string& name, const Value& value);
    Value get(const std::string& name) const;
    bool has(const std::string& name) const;

private:
    std::unordered_map<std::string, Value> variables_;
};

} // namespace runtime
