#include "runtime/value.hpp"

#include <cassert>

namespace runtime {

Value::Value() : type_(ValueType::Null), intValue_(0), objectHandle_(gc::ObjectHandle::invalid()) {}

Value::Value(int i) : type_(ValueType::Int), intValue_(i), objectHandle_(gc::ObjectHandle::invalid()) {}

Value::Value(gc::ObjectHandle handle) : type_(ValueType::Object), intValue_(0), objectHandle_(handle) {}

int Value::asInt() const {
    assert(type_ == ValueType::Int);
    return intValue_;
}

gc::ObjectHandle Value::asObject() const {
    assert(type_ == ValueType::Object);
    return objectHandle_;
}

} // namespace runtime
