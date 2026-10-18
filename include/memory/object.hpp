#pragma once

// memory::Object -- internal heap object representation.
// Owned by Akshat. Never included by interpreter/runtime code.

#include <string>
#include <unordered_map>

#include "gc_interface.hpp"
#include "memory/observer.hpp"

namespace memory {

class Object {
public:
    Object() = default;

    void setField(const std::string& name, gc::ObjectHandle target);
    gc::ObjectHandle getField(const std::string& name) const;

    const std::unordered_map<std::string, gc::ObjectHandle>& fields() const { return fields_; }

    // Mark-sweep bookkeeping bit. Managed entirely by mark.cpp / sweep.cpp.
    bool marked = false;
    std::uint64_t allocSeq = 0;
    std::uint32_t allocStatement = 0;

private:
    std::unordered_map<std::string, gc::ObjectHandle> fields_;
};

} // namespace memory
