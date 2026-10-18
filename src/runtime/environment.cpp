#include "runtime/environment.hpp"

namespace runtime {

void Environment::define(const std::string& name, const Value& value) {
    variables_[name] = value;
}

Value Environment::get(const std::string& name) const {
    auto it = variables_.find(name);
    if (it == variables_.end()) {
        return Value(); // null
    }
    return it->second;
}

bool Environment::has(const std::string& name) const {
    return variables_.find(name) != variables_.end();
}

} // namespace runtime
