#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <exception>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <random>
#include <sstream>
#include <streambuf>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

#include "errors.hpp"
#include "interpreter/ast.hpp"
#include "interpreter/interpreter.hpp"
#include "interpreter/lexer.hpp"
#include "interpreter/parser.hpp"
#include "json_writer.hpp"
#include "memory/heap.hpp"
#include "region_writer.hpp"
#include "spans.hpp"
#include "toy_ast_json.hpp"
#include "tracing_heap.hpp"

#ifndef GCD_GIT_COMMIT
#define GCD_GIT_COMMIT "unknown"
#endif

namespace {

constexpr std::size_t kMaxSourceBytes = 65536;
constexpr std::size_t kMaxStdoutBytes = 65536;
constexpr std::uint64_t kEstimatedFieldNodeBytes =
    sizeof(std::pair<const std::string, gc::ObjectHandle>) + 2 * sizeof(void*);
constexpr char kEstimatedBytesNote[] =
    "sizeof(memory::Object) per object plus sizeof(pair<const string,ObjectHandle>) "
    "and two pointers per field; excludes string character storage, allocator, and "
    "bucket-array overhead";

std::uint64_t estimatedBytes(std::uint64_t objectCount, std::uint64_t fieldCount) {
    return objectCount * sizeof(memory::Object) + fieldCount * kEstimatedFieldNodeBytes;
}

class Sha256 {
public:
    void update(const unsigned char* data, std::size_t size) {
        totalBytes_ += size;
        while (size > 0) {
            const std::size_t available = buffer_.size() - bufferedBytes_;
            const std::size_t amount = std::min(available, size);
            std::copy_n(data, amount, buffer_.begin() + static_cast<std::ptrdiff_t>(bufferedBytes_));
            bufferedBytes_ += amount;
            data += amount;
            size -= amount;
            if (bufferedBytes_ == buffer_.size()) {
                transform(buffer_.data());
                bufferedBytes_ = 0;
            }
        }
    }

    std::string finish() {
        const std::uint64_t bitLength = totalBytes_ * 8;
        buffer_[bufferedBytes_++] = 0x80;
        if (bufferedBytes_ > 56) {
            std::fill(buffer_.begin() + static_cast<std::ptrdiff_t>(bufferedBytes_),
                      buffer_.end(), 0);
            transform(buffer_.data());
            bufferedBytes_ = 0;
        }
        std::fill(buffer_.begin() + static_cast<std::ptrdiff_t>(bufferedBytes_),
                  buffer_.begin() + 56, 0);
        for (unsigned int i = 0; i < 8; ++i) {
            buffer_[63 - i] = static_cast<unsigned char>(bitLength >> (i * 8));
        }
        transform(buffer_.data());

        static constexpr char hex[] = "0123456789abcdef";
        std::string result;
        result.reserve(64);
        for (const std::uint32_t word : state_) {
            for (int shift = 28; shift >= 0; shift -= 4) {
                result.push_back(hex[(word >> shift) & 0x0f]);
            }
        }
        return result;
    }

private:
    static std::uint32_t rotateRight(std::uint32_t value, unsigned int amount) {
        return (value >> amount) | (value << (32 - amount));
    }

    void transform(const unsigned char* block) {
        static constexpr std::array<std::uint32_t, 64> constants = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
            0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
            0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
            0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
            0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        std::array<std::uint32_t, 64> words{};
        for (std::size_t i = 0; i < 16; ++i) {
            const std::size_t offset = i * 4;
            words[i] = (static_cast<std::uint32_t>(block[offset]) << 24) |
                       (static_cast<std::uint32_t>(block[offset + 1]) << 16) |
                       (static_cast<std::uint32_t>(block[offset + 2]) << 8) |
                       static_cast<std::uint32_t>(block[offset + 3]);
        }
        for (std::size_t i = 16; i < words.size(); ++i) {
            const std::uint32_t s0 = rotateRight(words[i - 15], 7) ^
                                     rotateRight(words[i - 15], 18) ^
                                     (words[i - 15] >> 3);
            const std::uint32_t s1 = rotateRight(words[i - 2], 17) ^
                                     rotateRight(words[i - 2], 19) ^
                                     (words[i - 2] >> 10);
            words[i] = words[i - 16] + s0 + words[i - 7] + s1;
        }

        std::uint32_t a = state_[0];
        std::uint32_t b = state_[1];
        std::uint32_t c = state_[2];
        std::uint32_t d = state_[3];
        std::uint32_t e = state_[4];
        std::uint32_t f = state_[5];
        std::uint32_t g = state_[6];
        std::uint32_t h = state_[7];
        for (std::size_t i = 0; i < words.size(); ++i) {
            const std::uint32_t sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const std::uint32_t choice = (e & f) ^ (~e & g);
            const std::uint32_t temp1 = h + sum1 + choice + constants[i] + words[i];
            const std::uint32_t sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
            const std::uint32_t temp2 = sum0 + majority;
            h = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
        }
        state_[0] += a;
        state_[1] += b;
        state_[2] += c;
        state_[3] += d;
        state_[4] += e;
        state_[5] += f;
        state_[6] += g;
        state_[7] += h;
    }

    std::array<std::uint32_t, 8> state_ = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    std::array<unsigned char, 64> buffer_{};
    std::size_t bufferedBytes_ = 0;
    std::uint64_t totalBytes_ = 0;
};

struct Arguments {
    std::string sourcePath;
    std::string resultPath;
    std::string runId;
    std::string tracePath;
    TraceLevel traceLevel = TraceLevel::Off;
    std::size_t batchSize = 1024;
    std::string snapshotsDirectory;
    std::size_t snapshotMaxObjects = 2000;
    std::uint32_t regionSize = 0;
    bool slotReuse = false;
    std::string regionsDirectory;
};

struct RunData {
    std::string runId;
    std::string sourceSha256;
    std::string createdAt;
    std::string startedAt;
    std::string endedAt;
    std::string status = "succeeded";
    std::string stdout;
    bool stdoutTruncated = false;
    std::string astJson = "null";
    std::uint64_t nodeCount = 0;
    bool astTruncated = false;
    bool analysisFailed = false;
    bool executionFailed = false;
    double analysisMs = 0;
    double executeMs = 0;
    double wallTimeMs = 0;
    std::uint64_t statementsExecuted = 0;
    std::uint64_t estimatedLiveFieldNodes = 0;
    bool observerEnabled = false;
    gc::GCStats stats;
    std::vector<memory::CollectionRecord> collections;
    std::vector<std::uint64_t> collectionStatementIndices;
    std::vector<SnapshotRecord> snapshots;
    std::vector<RegionGraphRecord> regionGraphs;
    std::uint32_t regionSize = 0;
    bool slotReuse = false;
    std::vector<RunnerError> errors;
};

class BoundedStringBuf final : public std::streambuf {
public:
    explicit BoundedStringBuf(std::size_t limit) : limit_(limit) {}

    bool truncated() const {
        return truncated_;
    }

    const std::string& value() const {
        return value_;
    }

protected:
    int_type overflow(int_type character) override {
        if (traits_type::eq_int_type(character, traits_type::eof())) {
            return traits_type::not_eof(character);
        }
        if (value_.size() < limit_) {
            value_.push_back(traits_type::to_char_type(character));
        } else {
            truncated_ = true;
        }
        return character;
    }

    std::streamsize xsputn(const char* data, std::streamsize count) override {
        const std::size_t requested = static_cast<std::size_t>(count);
        const std::size_t available = limit_ - value_.size();
        const std::size_t stored = std::min(available, requested);
        value_.append(data, stored);
        if (stored < requested) {
            truncated_ = true;
        }
        return count;
    }

private:
    std::size_t limit_;
    std::string value_;
    bool truncated_ = false;
};

class CoutRedirect {
public:
    explicit CoutRedirect(std::streambuf* replacement)
        : previous_(std::cout.rdbuf(replacement)) {}
    ~CoutRedirect() {
        std::cout.rdbuf(previous_);
    }

    CoutRedirect(const CoutRedirect&) = delete;
    CoutRedirect& operator=(const CoutRedirect&) = delete;

private:
    std::streambuf* previous_;
};

std::string timestamp() {
    const auto now = std::chrono::system_clock::now();
    const auto milliseconds =
        std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch());
    const std::time_t seconds =
        static_cast<std::time_t>(milliseconds.count() / 1000);
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s(&utc, &seconds);
#else
    gmtime_r(&seconds, &utc);
#endif
    std::ostringstream result;
    result << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.'
           << std::setw(3) << std::setfill('0')
           << (milliseconds.count() % 1000) << 'Z';
    return result.str();
}

std::string generateUlid() {
    static constexpr char alphabet[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    std::array<unsigned char, 16> bytes{};
    const auto now = std::chrono::system_clock::now();
    const std::uint64_t millis = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count());
    for (int i = 5; i >= 0; --i) {
        bytes[static_cast<std::size_t>(i)] =
            static_cast<unsigned char>(millis >> ((5 - i) * 8));
    }
    std::random_device random;
    for (std::size_t i = 6; i < bytes.size(); ++i) {
        bytes[i] = static_cast<unsigned char>(random());
    }
    std::string id;
    id.reserve(26);
    for (int group = 0; group < 26; ++group) {
        unsigned int value = 0;
        for (int bit = 0; bit < 5; ++bit) {
            const int sourceBit = group * 5 + bit - 2;
            value <<= 1;
            if (sourceBit >= 0 && sourceBit < 128) {
                const std::size_t byteIndex = static_cast<std::size_t>(sourceBit / 8);
                const unsigned int bitIndex = static_cast<unsigned int>(7 - sourceBit % 8);
                value |= (bytes[byteIndex] >> bitIndex) & 1U;
            }
        }
        id.push_back(alphabet[value]);
    }
    return id;
}

bool isValidUlid(const std::string& id) {
    static const std::string alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    return id.size() == 26 && id.find_first_not_of(alphabet) == std::string::npos &&
           id.front() <= '7';
}

bool readSource(const std::string& path, std::string& source, std::string& digest,
                bool& tooLarge, std::string& error) {
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        error = "could not open source file";
        return false;
    }

    Sha256 hasher;
    std::array<char, 8192> chunk{};
    std::uint64_t totalBytes = 0;
    while (input) {
        input.read(chunk.data(), static_cast<std::streamsize>(chunk.size()));
        const std::streamsize readCount = input.gcount();
        if (readCount > 0) {
            const auto count = static_cast<std::size_t>(readCount);
            hasher.update(reinterpret_cast<const unsigned char*>(chunk.data()), count);
            totalBytes += count;
            if (source.size() <= kMaxSourceBytes) {
                const std::size_t remaining = kMaxSourceBytes + 1 - source.size();
                source.append(chunk.data(), std::min(count, remaining));
            }
            if (totalBytes > kMaxSourceBytes) {
                tooLarge = true;
            }
        }
    }
    if (!input.eof()) {
        error = "failed while reading source file";
        return false;
    }
    digest = hasher.finish();
    if (tooLarge) {
        source.clear();
    }
    return true;
}

std::optional<Arguments> parseArguments(int argc, char** argv) {
    Arguments arguments;
    const auto parseSize = [](const std::string& value, std::size_t maximum,
                              std::size_t& parsed) {
        if (value.empty()) {
            return false;
        }
        std::size_t result = 0;
        for (const char character : value) {
            if (character < '0' || character > '9') {
                return false;
            }
            const std::size_t digit = static_cast<std::size_t>(character - '0');
            if (result > (maximum - digit) / 10) {
                return false;
            }
            result = result * 10 + digit;
        }
        parsed = result;
        return true;
    };

    for (int i = 1; i < argc; ++i) {
        const std::string flag = argv[i];
        if (flag == "--slot-reuse") {
            arguments.slotReuse = true;
        } else if (i + 1 < argc &&
            (flag == "--source" || flag == "--result" || flag == "--run-id" ||
             flag == "--trace" || flag == "--trace-level" || flag == "--batch-size" ||
             flag == "--snapshots-dir" || flag == "--snapshot-max-objects" ||
             flag == "--region-size" || flag == "--regions-dir")) {
            const std::string value = argv[++i];
            if (flag == "--source") {
                arguments.sourcePath = value;
            } else if (flag == "--result") {
                arguments.resultPath = value;
            } else if (flag == "--run-id") {
                arguments.runId = value;
            } else if (flag == "--trace") {
                arguments.tracePath = value;
            } else if (flag == "--trace-level") {
                if (value == "off") {
                    arguments.traceLevel = TraceLevel::Off;
                } else if (value == "gc") {
                    arguments.traceLevel = TraceLevel::Gc;
                } else if (value == "mutator") {
                    arguments.traceLevel = TraceLevel::Mutator;
                } else if (value == "full") {
                    arguments.traceLevel = TraceLevel::Full;
                } else {
                    return std::nullopt;
                }
            } else if (flag == "--batch-size") {
                if (!parseSize(value, 8192, arguments.batchSize) ||
                    arguments.batchSize == 0) {
                    return std::nullopt;
                }
            } else if (flag == "--region-size") {
                std::size_t parsedSize = 0;
                if (!parseSize(value, 256, parsedSize) ||
                    (parsedSize != 0 && parsedSize != 16 && parsedSize != 32 && parsedSize != 64 &&
                     parsedSize != 128 && parsedSize != 256)) {
                    return std::nullopt;
                }
                arguments.regionSize = static_cast<std::uint32_t>(parsedSize);
            } else if (flag == "--regions-dir") {
                arguments.regionsDirectory = value;
            } else if (flag == "--snapshots-dir") {
                arguments.snapshotsDirectory = value;
            } else if (flag == "--snapshot-max-objects") {
                if (!parseSize(value, 2000, arguments.snapshotMaxObjects) ||
                    arguments.snapshotMaxObjects == 0) {
                    return std::nullopt;
                }
            }
        } else {
            return std::nullopt;
        }
    }
    if (arguments.sourcePath.empty() || arguments.resultPath.empty() ||
        (!arguments.runId.empty() && !isValidUlid(arguments.runId)) ||
        (arguments.tracePath.empty() && arguments.traceLevel != TraceLevel::Off) ||
        (arguments.snapshotsDirectory.empty() && arguments.snapshotMaxObjects != 2000) ||
        (!arguments.regionsDirectory.empty() && arguments.regionSize == 0)) {
        return std::nullopt;
    }
    return arguments;
}

template <typename Number>
void writeMetric(JsonWriter& writer, Number value, const std::string& unit,
                 const std::string& source, const std::string& provenance = "measured",
                 const std::string& note = "") {
    writer.beginObject();
    writer.key("value");
    if constexpr (std::is_floating_point_v<Number>) {
        writer.number(static_cast<double>(value));
    } else if constexpr (std::is_signed_v<Number>) {
        writer.number(static_cast<std::int64_t>(value));
    } else {
        writer.number(static_cast<std::uint64_t>(value));
    }
    writer.key("unit");
    writer.string(unit);
    writer.key("provenance");
    writer.string(provenance);
    writer.key("source");
    writer.string(source);
    if (!note.empty()) {
        writer.key("note");
        writer.string(note);
    }
    writer.endObject();
}

void writeUnavailableMetric(JsonWriter& writer, const std::string& unit,
                            const std::string& source, const std::string& note) {
    writer.beginObject();
    writer.key("value");
    writer.nullValue();
    writer.key("unit");
    writer.string(unit);
    writer.key("provenance");
    writer.string("unavailable");
    writer.key("source");
    writer.string(source);
    writer.key("note");
    writer.string(note);
    writer.endObject();
}

void writePhase(JsonWriter& writer, const std::string& status, double durationMs,
                std::optional<std::int64_t> exitCode = std::nullopt) {
    writer.beginObject();
    writer.key("status");
    writer.string(status);
    writer.key("durationMs");
    writeMetric(writer, durationMs, "ms", "std::chrono::steady_clock");
    if (exitCode) {
        writer.key("exitCode");
        writer.number(*exitCode);
    }
    writer.endObject();
}

void writeError(JsonWriter& writer, const RunnerError& error) {
    writer.beginObject();
    writer.key("code");
    writer.string(error.code);
    writer.key("phase");
    writer.string(error.phase);
    writer.key("message");
    writer.string(error.message);
    if (error.location) {
        const SourceSpan& span = *error.location;
        writer.key("location");
        writer.beginObject();
        writer.key("line");
        writer.number(span.line);
        writer.key("column");
        writer.number(span.column);
        writer.key("endLine");
        writer.number(span.endLine);
        writer.key("endColumn");
        writer.number(span.endColumn);
        writer.key("startOffset");
        writer.number(span.start);
        writer.key("endOffset");
        writer.number(span.end);
        writer.key("provenance");
        writer.string("derived");
        writer.endObject();
    }
    writer.endObject();
}

void writeCollectionMetric(JsonWriter& writer, std::uint64_t value,
                           const std::string& unit, const std::string& source,
                           const std::string& note = "") {
    writeMetric(writer, value, unit, source, "measured", note);
}

std::string serializeResult(const RunData& run) {
    JsonWriter writer;
    writer.beginObject();
    writer.key("schema");
    writer.string("gcd.run-result/1");
    writer.key("runId");
    writer.string(run.runId);
    writer.key("engine");
    writer.string("custom");
    writer.key("language");
    writer.string("gcd-toy");
    writer.key("sourceSha256");
    writer.string(run.sourceSha256);
    writer.key("createdAt");
    writer.string(run.createdAt);
    writer.key("startedAt");
    writer.string(run.startedAt);
    writer.key("endedAt");
    writer.string(run.endedAt);
    writer.key("status");
    writer.string(run.status);

    writer.key("phases");
    writer.beginObject();
    writer.key("analysis");
    writePhase(writer, run.analysisFailed ? "failed" : "ok", run.analysisMs,
               run.analysisFailed ? std::optional<std::int64_t>(2) : std::nullopt);
    writer.key("execute");
    writePhase(writer, run.executionFailed ? "failed" : (run.analysisFailed ? "skipped" : "ok"),
               run.executeMs,
               run.executionFailed ? std::optional<std::int64_t>(2) : std::nullopt);
    writer.endObject();

    writer.key("output");
    writer.beginObject();
    writer.key("stdout");
    writer.string(run.stdout);
    writer.key("stderr");
    writer.string("");
    writer.key("stdoutTruncated");
    writer.boolean(run.stdoutTruncated);
    writer.key("stderrTruncated");
    writer.boolean(false);
    writer.endObject();

    writer.key("errors");
    writer.beginArray();
    for (const RunnerError& error : run.errors) {
        writeError(writer, error);
    }
    writer.endArray();

    writer.key("staticAnalysis");
    writer.beginObject();
    writer.key("schema");
    writer.string("gcd.static-analysis/1");
    writer.key("language");
    writer.string("gcd-toy");
    writer.key("ast");
    if (run.analysisFailed) {
        writer.nullValue();
    } else {
        writer.rawValue(run.astJson);
    }
    writer.key("nodeCount");
    writer.number(run.nodeCount);
    writer.key("truncated");
    writer.boolean(run.astTruncated);
    writer.key("diagnostics");
    writer.beginArray();
    for (const RunnerError& error : run.errors) {
        if (error.phase != "analysis") {
            continue;
        }
        writer.beginObject();
        writer.key("severity");
        writer.string("error");
        writer.key("code");
        writer.string(error.code);
        writer.key("message");
        writer.string(error.message);
        writer.endObject();
    }
    writer.endArray();
    writer.endObject();

    writer.key("engineResult");
    writer.beginObject();
    writer.key("kind");
    writer.string("custom");
    writer.key("runtime");
    writer.beginObject();
    writer.key("version");
    writer.string("v2");
    writer.key("gitCommit");
    writer.string(GCD_GIT_COMMIT);
    writer.key("heap");
    writer.beginObject();
    writer.key("regionSize");
    writer.number(static_cast<std::uint64_t>(run.regionSize));
    writer.key("slotReuse");
    writer.boolean(run.slotReuse);
    writer.key("observer");
    writer.boolean(run.observerEnabled);
    writer.endObject();
    writer.endObject();

    writer.key("totals");
    writer.beginObject();
    const std::uint64_t freedTotal = [&run] {
        std::uint64_t total = 0;
        for (const auto& record : run.collections) {
            total += record.freed;
        }
        return total;
    }();
    const std::uint64_t freedFieldNodes = [&run] {
        std::uint64_t total = 0;
        for (const auto& record : run.collections) {
            total += record.fieldNodesFreed;
        }
        return total;
    }();
    const std::uint64_t liveAtEnd =
        run.stats.totalAllocations >= freedTotal ? run.stats.totalAllocations - freedTotal : 0;
    writer.key("allocations");
    writeMetric(writer, run.stats.totalAllocations, "objects", "gc::GCStats.totalAllocations");
    writer.key("collections");
    writeMetric(writer, run.stats.totalCollections, "count", "gc::GCStats.totalCollections");
    writer.key("freed");
    writeMetric(writer, freedTotal, "objects", "memory::GcDiagnostics.collections.freed");
    writer.key("liveAfter");
    writeMetric(writer, liveAtEnd, "objects", "allocations minus cumulative freed");
    writer.key("estimatedBytesFreed");
    writeMetric(writer, estimatedBytes(freedTotal, freedFieldNodes), "B",
                "sizeof(memory::Object) plus estimated field-node footprint", "estimated",
                kEstimatedBytesNote);
    writer.key("estimatedLiveBytes");
    writeMetric(writer, estimatedBytes(liveAtEnd, run.estimatedLiveFieldNodes),
                "B", "sizeof(memory::Object) plus estimated field-node footprint",
                "estimated", kEstimatedBytesNote);
    writer.key("statementsExecuted");
    writeMetric(writer, run.statementsExecuted, "count", "gcd_runner");
    writer.key("wallTimeMs");
    writeMetric(writer, run.wallTimeMs, "ms", "std::chrono::steady_clock");
    writer.key("pauseFraction");
    writeUnavailableMetric(writer, "ratio", "custom-runtime",
                           "single-threaded runtime with explicit collections");
    writer.endObject();

    writer.key("collections");
    writer.beginArray();
    for (std::size_t i = 0; i < run.collections.size(); ++i) {
        const memory::CollectionRecord& record = run.collections[i];
        const std::uint64_t statementIndex = run.collectionStatementIndices.at(i);
        writer.beginObject();
        writer.key("gcIndex");
        writer.number(record.gcIndex);
        writer.key("statementIndex");
        writer.number(statementIndex);
        writer.key("liveBefore");
        writeCollectionMetric(writer, record.liveBefore, "objects", "memory::GcDiagnostics");
        writer.key("marked");
        writeCollectionMetric(writer, record.marked, "objects", "memory::GcDiagnostics");
        writer.key("freed");
        writeCollectionMetric(writer, record.freed, "objects", "memory::GcDiagnostics");
        writer.key("liveAfter");
        writeCollectionMetric(writer, record.liveAfter, "objects", "memory::GcDiagnostics");
        writer.key("fieldsScanned");
        writeCollectionMetric(writer, record.fieldsScanned, "count", "memory::GcDiagnostics");
        writer.key("refsPushed");
        writeCollectionMetric(writer, record.refsPushed, "count", "memory::GcDiagnostics");
        writer.key("worklistPeak");
        writeCollectionMetric(writer, record.worklistPeak, "entries", "memory::GcDiagnostics");
        writer.key("slotsScanned");
        writeCollectionMetric(writer, record.slotsScanned, "count", "memory::GcDiagnostics");
        writer.key("markNs");
        writeCollectionMetric(writer, record.markNs, "ns", "std::chrono::steady_clock");
        writer.key("sweepNs");
        writeCollectionMetric(writer, record.sweepNs, "ns", "std::chrono::steady_clock");
        writer.key("totalNs");
        writeCollectionMetric(writer, record.totalNs, "ns", "std::chrono::steady_clock");
        writer.key("estimatedBytesFreed");
        writeMetric(writer, estimatedBytes(record.freed, record.fieldNodesFreed), "B",
                    "sizeof(memory::Object) plus estimated field-node footprint", "estimated",
                    kEstimatedBytesNote);
        writer.endObject();
    }
    writer.endArray();
    writer.key("snapshots");
    writer.beginArray();
    for (const SnapshotRecord& snapshot : run.snapshots) {
        writer.beginObject();
        writer.key("index");
        writer.number(snapshot.index);
        writer.key("gcIndex");
        if (snapshot.gcIndex) {
            writer.number(*snapshot.gcIndex);
        } else {
            writer.nullValue();
        }
        writer.key("point");
        writer.string(snapshot.point);
        writer.key("objectCount");
        writer.number(snapshot.objectCount);
        writer.key("truncated");
        writer.boolean(snapshot.truncated);
        writer.endObject();
    }
    writer.endArray();
    writer.key("regionGraphs");
    writer.beginArray();
    for (const RegionGraphRecord& graph : run.regionGraphs) {
        writer.beginObject();
        writer.key("index");
        writer.number(graph.index);
        writer.key("gcIndex");
        if (graph.gcIndex) {
            writer.number(*graph.gcIndex);
        } else {
            writer.nullValue();
        }
        writer.key("point");
        writer.string(graph.point);
        writer.key("regionCount");
        writer.number(graph.regionCount);
        writer.key("verified");
        writer.boolean(graph.verified);
        writer.endObject();
    }
    writer.endArray();
    writer.endObject();

    writer.key("limits");
    writer.beginObject();
    writer.key("sourceBytes");
    writer.number(static_cast<std::uint64_t>(kMaxSourceBytes));
    writer.key("stdoutBytes");
    writer.number(static_cast<std::uint64_t>(kMaxStdoutBytes));
    writer.key("prlimit");
    writer.string("unsupported-platform");
    writer.endObject();

    writer.key("toolVersions");
    writer.beginObject();
    writer.key("controller");
    writer.string("not-present");
    writer.key("runner");
    writer.string("v2");
    writer.key("gitCommit");
    writer.string(GCD_GIT_COMMIT);
    writer.endObject();
    writer.endObject();
    return writer.str();
}

bool writeAtomically(const std::string& path, const std::string& value,
                     std::string& error) {
    const std::string temporaryPath = path + ".tmp";
    {
        std::ofstream output(temporaryPath, std::ios::binary | std::ios::trunc);
        if (!output) {
            error = "could not open temporary result file";
            return false;
        }
        output.write(value.data(), static_cast<std::streamsize>(value.size()));
        output.flush();
        if (!output) {
            error = "failed while writing temporary result file";
            return false;
        }
    }
    if (std::rename(temporaryPath.c_str(), path.c_str()) != 0) {
        error = "could not rename temporary result file into place";
        return false;
    }
    return true;
}

int writeAndExit(const Arguments& arguments, const RunData& run, int exitCode) {
    std::string error;
    if (!writeAtomically(arguments.resultPath, serializeResult(run), error)) {
        std::cerr << error << '\n';
        return 3;
    }
    return exitCode;
}

int runProgram(const Arguments& arguments) {
    RunData run;
    run.runId = arguments.runId.empty() ? generateUlid() : arguments.runId;
    run.createdAt = timestamp();
    run.startedAt = run.createdAt;
    const auto wallStart = std::chrono::steady_clock::now();
    std::unique_ptr<FileSink> traceSink;
    std::unique_ptr<EventBuffer> eventBuffer;
    std::unique_ptr<SnapshotWriter> snapshotWriter;
    std::unique_ptr<RunnerObserver> observer;
    if (!arguments.tracePath.empty()) {
        traceSink = std::make_unique<FileSink>(arguments.tracePath);
        eventBuffer = std::make_unique<EventBuffer>(
            *traceSink, run.runId, arguments.batchSize, arguments.traceLevel);
    }
    if (!arguments.snapshotsDirectory.empty()) {
        snapshotWriter = std::make_unique<SnapshotWriter>(
            arguments.snapshotsDirectory, run.runId, arguments.snapshotMaxObjects);
    }
    const auto finishOutputs = [&]() {
        if (eventBuffer) {
            eventBuffer->finish();
            if (!eventBuffer->error().empty()) {
                run.errors.push_back(
                    RunnerError{"TRACE_IO", "controller", eventBuffer->error(), std::nullopt});
                run.status = "internal_error";
            }
        }
        if (snapshotWriter && !snapshotWriter->error().empty()) {
            run.errors.push_back(RunnerError{"SNAPSHOT_IO", "controller",
                                             snapshotWriter->error(), std::nullopt});
            run.status = "internal_error";
        }
        if (observer && !observer->error().empty() &&
            (!snapshotWriter || snapshotWriter->error().empty())) {
            run.errors.push_back(
                RunnerError{"SNAPSHOT_IO", "controller", observer->error(), std::nullopt});
            run.status = "internal_error";
        }
    };
    const auto finishAndWrite = [&](int exitCode) {
        finishOutputs();
        if (snapshotWriter) {
            run.snapshots = snapshotWriter->records();
        }
        if (run.status == "internal_error") {
            return writeAndExit(arguments, run, 4);
        }
        return writeAndExit(arguments, run, exitCode);
    };

    std::string source;
    std::string readError;
    bool tooLarge = false;
    if (!readSource(arguments.sourcePath, source, run.sourceSha256, tooLarge, readError)) {
        std::cerr << readError << ": " << arguments.sourcePath << '\n';
        if (eventBuffer) {
            eventBuffer->finish();
            if (!eventBuffer->error().empty()) {
                std::cerr << eventBuffer->error() << '\n';
            }
        }
        return 3;
    }

    if (tooLarge) {
        run.analysisFailed = true;
        run.status = "program_error";
        run.errors.push_back(
            RunnerError{"SOURCE_TOO_LARGE", "request",
                        "source exceeds the 65536-byte limit", std::nullopt});
        run.endedAt = timestamp();
        run.wallTimeMs = std::chrono::duration<double, std::milli>(
                             std::chrono::steady_clock::now() - wallStart)
                             .count();
        return finishAndWrite(2);
    }

    interpreter::Program program;
    const auto analysisStart = std::chrono::steady_clock::now();
    try {
        interpreter::Lexer lexer(source);
        interpreter::Parser parser(lexer.tokenize());
        program = parser.parseProgram();
    } catch (const std::exception& exception) {
        run.analysisFailed = true;
        run.status = "program_error";
        run.errors.push_back(classifyRunnerError(exception.what(), "analysis"));
        run.analysisMs = std::chrono::duration<double, std::milli>(
                             std::chrono::steady_clock::now() - analysisStart)
                             .count();
        run.endedAt = timestamp();
        run.wallTimeMs = std::chrono::duration<double, std::milli>(
                             std::chrono::steady_clock::now() - wallStart)
                             .count();
        return finishAndWrite(2);
    }
    run.analysisMs = std::chrono::duration<double, std::milli>(
                         std::chrono::steady_clock::now() - analysisStart)
                         .count();

    std::vector<SourceSpan> spans;
    try {
        spans = deriveStatementSpans(source, program.statements.size());
        run.astJson =
            writeToyAstJson(program, spans, run.nodeCount, run.astTruncated);
    } catch (const std::exception& exception) {
        run.analysisFailed = true;
        run.status = "internal_error";
        run.errors.push_back(
            RunnerError{"INTERNAL", "controller", exception.what(), std::nullopt});
        run.endedAt = timestamp();
        run.wallTimeMs = std::chrono::duration<double, std::milli>(
                             std::chrono::steady_clock::now() - wallStart)
                             .count();
        return finishAndWrite(4);
    }

    memory::Heap::Options heapOptions;
    heapOptions.regionSize = arguments.regionSize;
    heapOptions.slotReuse = arguments.slotReuse;
    run.regionSize = arguments.regionSize;
    run.slotReuse = arguments.slotReuse;
    memory::Heap heap(heapOptions);
    std::unique_ptr<RegionGraphWriter> regionWriter;
    if (!arguments.regionsDirectory.empty()) {
        regionWriter = std::make_unique<RegionGraphWriter>(arguments.regionsDirectory, run.runId);
    }
    EventBuffer* activeEvents =
        eventBuffer && arguments.traceLevel != TraceLevel::Off ? eventBuffer.get() : nullptr;
    run.observerEnabled = activeEvents != nullptr || snapshotWriter != nullptr;
    if (run.observerEnabled) {
        const bool recordMarkForest =
            snapshotWriter != nullptr || arguments.traceLevel == TraceLevel::Full;
        observer = std::make_unique<RunnerObserver>(
            activeEvents, snapshotWriter.get(), recordMarkForest);
        heap.setObserver(observer.get());
    }
    TracingHeap tracingHeap(heap, activeEvents);
    interpreter::Interpreter interpreter(tracingHeap);
    BoundedStringBuf stdoutBuffer(kMaxStdoutBytes);
    const auto executeStart = std::chrono::steady_clock::now();
    {
        CoutRedirect redirect(&stdoutBuffer);
        for (std::size_t i = 0; i < program.statements.size(); ++i) {
            interpreter::Program singleStatement;
            singleStatement.statements.push_back(program.statements[i]);
            tracingHeap.beginStatement(static_cast<std::uint32_t>(i));
            if (observer) {
                observer->setCurrentStatement(static_cast<std::uint32_t>(i));
            }
            try {
                interpreter.run(singleStatement);
                ++run.statementsExecuted;
                const auto& records = tracingHeap.diagnostics().collections;
                while (run.collections.size() < records.size()) {
                    run.collections.push_back(records[run.collections.size()]);
                    run.collectionStatementIndices.push_back(i);
                    if (regionWriter) {
                        // State after the sweep: survivors and per-GC frees are final.
                        regionWriter->write("gc_end", heap.regionGraph(),
                                            run.collections.back().gcIndex,
                                            static_cast<std::uint32_t>(i));
                    }
                }
            } catch (const std::exception& exception) {
                run.executionFailed = true;
                run.status = "program_error";
                std::optional<SourceSpan> location;
                if (std::string(exception.what()).rfind("Interpreter:", 0) == 0) {
                    location = spans.at(i);
                }
                run.errors.push_back(classifyRunnerError(exception.what(), "execute", location));
                tracingHeap.endStatement(static_cast<std::uint32_t>(i));
                break;
            }
            tracingHeap.endStatement(static_cast<std::uint32_t>(i));
        }
    }
    run.stdout = stdoutBuffer.value();
    run.stdoutTruncated = stdoutBuffer.truncated();
    run.executeMs = std::chrono::duration<double, std::milli>(
                        std::chrono::steady_clock::now() - executeStart)
                        .count();
    run.stats = tracingHeap.getStats();
    run.estimatedLiveFieldNodes = tracingHeap.diagnostics().currentFieldNodes;
    if (snapshotWriter) {
        const auto endSnapshot =
            snapshotWriter->write("program_end", heap.view(), std::nullopt,
                                  static_cast<std::uint32_t>(run.statementsExecuted));
        (void)endSnapshot;
    }
    if (regionWriter) {
        regionWriter->write("program_end", heap.regionGraph(), std::nullopt,
                            static_cast<std::uint32_t>(run.statementsExecuted));
        run.regionGraphs = regionWriter->records();
        if (!regionWriter->error().empty()) {
            run.errors.push_back(
                RunnerError{"REGION_IO", "controller", regionWriter->error(), std::nullopt});
            run.status = "internal_error";
        }
    }
    if (!run.executionFailed && run.status != "internal_error") {
        run.status = "succeeded";
    }
    run.endedAt = timestamp();
    run.wallTimeMs = std::chrono::duration<double, std::milli>(
                         std::chrono::steady_clock::now() - wallStart)
                         .count();
    return finishAndWrite(run.executionFailed ? 2 : 0);
}

} // namespace

int main(int argc, char** argv) {
    const auto arguments = parseArguments(argc, argv);
    if (!arguments) {
        std::cerr << "usage: gcd_runner --source <path> --result <path> [--run-id <ulid>]\n";
        return 3;
    }
    try {
        return runProgram(*arguments);
    } catch (const std::exception& exception) {
        std::cerr << "gcd_runner internal error: " << exception.what() << '\n';
        return 4;
    } catch (...) {
        std::cerr << "gcd_runner internal error: unknown exception\n";
        return 4;
    }
}
