#pragma once

#include <cstdint>
#include <cmath>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

class JsonWriter {
public:
    void beginObject() {
        beforeValue();
        output_ << '{';
        scopes_.push_back(Scope{true, true, false});
    }

    void endObject() {
        requireScope(true);
        if (scopes_.back().expectsValue) {
            throw std::logic_error("JSON object key has no value");
        }
        output_ << '}';
        scopes_.pop_back();
    }

    void beginArray() {
        beforeValue();
        output_ << '[';
        scopes_.push_back(Scope{false, true, false});
    }

    void endArray() {
        requireScope(false);
        output_ << ']';
        scopes_.pop_back();
    }

    void key(const std::string& value) {
        requireScope(true);
        Scope& scope = scopes_.back();
        if (scope.expectsValue) {
            throw std::logic_error("JSON object key follows a key without a value");
        }
        if (!scope.first) {
            output_ << ',';
        }
        scope.first = false;
        writeEscaped(value);
        output_ << ':';
        scope.expectsValue = true;
    }

    void string(const std::string& value) {
        beforeValue();
        writeEscaped(value);
    }

    void number(std::uint64_t value) {
        beforeValue();
        output_ << value;
    }

    void number(std::int64_t value) {
        beforeValue();
        output_ << value;
    }

    void number(double value) {
        if (!std::isfinite(value)) {
            throw std::logic_error("JSON number must be finite");
        }
        beforeValue();
        output_ << std::setprecision(12) << value;
    }

    void boolean(bool value) {
        beforeValue();
        output_ << (value ? "true" : "false");
    }

    void nullValue() {
        beforeValue();
        output_ << "null";
    }

    void rawValue(const std::string& value) {
        beforeValue();
        output_ << value;
    }

    std::string str() const {
        if (!scopes_.empty()) {
            throw std::logic_error("JSON document has an unclosed container");
        }
        return output_.str();
    }

private:
    struct Scope {
        bool object;
        bool first;
        bool expectsValue;
    };

    void requireScope(bool object) const {
        if (scopes_.empty() || scopes_.back().object != object) {
            throw std::logic_error("Mismatched JSON container");
        }
    }

    void beforeValue() {
        if (scopes_.empty()) {
            return;
        }
        Scope& scope = scopes_.back();
        if (scope.object) {
            if (!scope.expectsValue) {
                throw std::logic_error("JSON object value has no key");
            }
            scope.expectsValue = false;
        } else {
            if (!scope.first) {
                output_ << ',';
            }
            scope.first = false;
        }
    }

    static std::size_t validUtf8Length(const std::string& value, std::size_t offset) {
        const unsigned char lead = static_cast<unsigned char>(value[offset]);
        std::size_t length = 0;
        std::uint32_t codePoint = 0;
        if (lead >= 0xc2 && lead <= 0xdf) {
            length = 2;
            codePoint = lead & 0x1f;
        } else if (lead >= 0xe0 && lead <= 0xef) {
            length = 3;
            codePoint = lead & 0x0f;
        } else if (lead >= 0xf0 && lead <= 0xf4) {
            length = 4;
            codePoint = lead & 0x07;
        } else {
            return 0;
        }
        if (offset + length > value.size()) {
            return 0;
        }
        for (std::size_t i = 1; i < length; ++i) {
            const unsigned char continuation =
                static_cast<unsigned char>(value[offset + i]);
            if ((continuation & 0xc0) != 0x80) {
                return 0;
            }
            codePoint = (codePoint << 6) | (continuation & 0x3f);
        }
        if ((length == 3 && codePoint < 0x800) ||
            (length == 4 && codePoint < 0x10000) ||
            (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) {
            return 0;
        }
        return length;
    }

    void writeEscaped(const std::string& value) {
        static constexpr char hex[] = "0123456789abcdef";
        output_ << '"';
        for (std::size_t i = 0; i < value.size();) {
            const unsigned char character = static_cast<unsigned char>(value[i]);
            switch (character) {
            case '"':
                output_ << "\\\"";
                ++i;
                break;
            case '\\':
                output_ << "\\\\";
                ++i;
                break;
            case '\b':
                output_ << "\\b";
                ++i;
                break;
            case '\f':
                output_ << "\\f";
                ++i;
                break;
            case '\n':
                output_ << "\\n";
                ++i;
                break;
            case '\r':
                output_ << "\\r";
                ++i;
                break;
            case '\t':
                output_ << "\\t";
                ++i;
                break;
            default:
                if (character < 0x20) {
                    output_ << "\\u00" << hex[character >> 4] << hex[character & 0x0f];
                    ++i;
                } else if (character < 0x80) {
                    output_ << static_cast<char>(character);
                    ++i;
                } else {
                    const std::size_t sequenceLength = validUtf8Length(value, i);
                    if (sequenceLength == 0) {
                        output_ << "\\u00" << hex[character >> 4] << hex[character & 0x0f];
                        ++i;
                    } else {
                        output_.write(value.data() + static_cast<std::ptrdiff_t>(i),
                                      static_cast<std::streamsize>(sequenceLength));
                        i += sequenceLength;
                    }
                }
                break;
            }
        }
        output_ << '"';
    }

    std::ostringstream output_;
    std::vector<Scope> scopes_;
};
