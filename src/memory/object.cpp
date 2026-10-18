#include "memory/object.hpp"

namespace memory {

void Object::setField(const std::string& name, gc::ObjectHandle target) {
    fields_[name] = target;
}

gc::ObjectHandle Object::getField(const std::string& name) const {
    auto it = fields_.find(name);
    if (it == fields_.end()) {
        return gc::ObjectHandle::invalid();
    }
    return it->second;
}

} // namespace memory
