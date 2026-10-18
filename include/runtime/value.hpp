#pragma once

// runtime::Value -- the only value type in the toy language.
// Owned by Prateek. Wraps either an int, null, or an opaque gc::ObjectHandle.
// Never exposes memory::Object.

#include "gc_interface.hpp"

namespace runtime {

enum class ValueType { Null, Int, Object };

class Value {
public:
    Value();                                  // null
    explicit Value(int i);
    explicit Value(gc::ObjectHandle handle);

    ValueType type() const { return type_; }
    bool isNull() const { return type_ == ValueType::Null; }
    bool isInt() const { return type_ == ValueType::Int; }
    bool isObject() const { return type_ == ValueType::Object; }

    int asInt() const;
    gc::ObjectHandle asObject() const;

private:
    ValueType type_;
    int intValue_;
    gc::ObjectHandle objectHandle_;
};

} // namespace runtime
