// Collector benchmark harness (G.6/G.7). Drives gc::IHeap directly from a seeded generator,
// exactly the interface the interpreter uses. One process runs one workload under one variant
// for `--warmup` + `--measure` iterations and writes one JSON file.
//
//   heap_bench --workload W1..W7 --variant NAME --warmup 5 --measure 10 --seed 1 --out f.json
//   heap_bench --h2 N --reps R --out f.json          (region overview vs snapshot, V2 only)
//
// Built with -DGCD_BENCH_BASELINE against the v1-baseline sources, only variant "A" exists.

#include <sys/resource.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <random>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "gc_interface.hpp"
#include "memory/heap.hpp"
#include "memory/object.hpp"

#ifndef GCD_BENCH_BASELINE
#include "event_buffer.hpp"
#include "tracing_heap.hpp"
#endif

namespace {

using Clock = std::chrono::steady_clock;

double msSince(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

struct Variant {
    std::string name;
    bool baseline = false;
    std::uint32_t regionSize = 0;
    bool slotReuse = false;
    int trace = 0;  // 0 off, 1 mutator, 2 full
    std::size_t batch = 1024;
};

std::vector<Variant> allVariants() {
    std::vector<Variant> list;
    list.push_back({"A", true, 0, false, 0, 0});
    list.push_back({"Aprime", false, 0, false, 0, 0});
    list.push_back({"Aprime2", false, 0, false, 0, 0});
    list.push_back({"B", false, 64, false, 0, 0});
    for (const std::size_t batch : {1, 64, 1024, 8192}) {
        list.push_back({"C-m-" + std::to_string(batch), false, 0, false, 1, batch});
        list.push_back({"C-f-" + std::to_string(batch), false, 0, false, 2, batch});
    }
    list.push_back({"D", false, 64, false, 1, 1024});
    list.push_back({"E", false, 0, true, 0, 0});
    list.push_back({"ED", false, 64, true, 1, 1024});
    return list;
}

struct Metrics {
    double totalMs = 0;
    double collectMs = 0;
    double markMs = -1;
    double sweepMs = -1;
    std::uint64_t allocations = 0;
    std::uint64_t collections = 0;
    std::uint64_t freedTotal = 0;
    std::uint64_t liveAfterLast = 0;
    std::uint64_t maxLiveBefore = 0;
    std::int64_t fieldsScanned = -1;
    std::int64_t slotsScanned = -1;
    std::int64_t marked = -1;
    std::int64_t staleWritesRejected = -1;
    std::uint64_t fieldWrites = 0;
    std::uint64_t traceEvents = 0;
    std::uint64_t traceDropped = 0;
    std::uint64_t traceBatches = 0;
    std::uint64_t traceBytes = 0;
    std::uint64_t bufferBytes = 0;
    std::uint64_t metadataBytes = 0;
    std::uint64_t digest = 1469598103934665603ULL;
    std::vector<double> roundCollectMs;  // W6: one entry per collection
};

void mixDigest(Metrics& metrics, std::uint64_t value) {
    metrics.digest ^= value;
    metrics.digest *= 1099511628211ULL;
}

// One heap plus whatever instrumentation the variant asks for.
struct Env {
    explicit Env(const Variant& variant, const std::string& scratch) {
#ifdef GCD_BENCH_BASELINE
        (void)variant;
        (void)scratch;
        heap = std::make_unique<memory::Heap>();
        api = heap.get();
#else
        memory::Heap::Options options;
        options.regionSize = variant.regionSize;
        options.slotReuse = variant.slotReuse;
        heap = std::make_unique<memory::Heap>(options);
        api = heap.get();
        if (variant.trace != 0) {
            tracePath = scratch + "/trace.ndjson";
            sink = std::make_unique<FileSink>(tracePath);
            events = std::make_unique<EventBuffer>(
                *sink, "01J00000000000000000000000", variant.batch,
                variant.trace == 2 ? TraceLevel::Full : TraceLevel::Mutator);
            observer = std::make_unique<RunnerObserver>(events.get(), nullptr, variant.trace == 2);
            heap->setObserver(observer.get());
            tracing = std::make_unique<TracingHeap>(*heap, events.get());
            api = tracing.get();
            bufferBytes = variant.batch * 48;
        }
#endif
    }

    std::unique_ptr<memory::Heap> heap;
    gc::IHeap* api = nullptr;
    std::uint64_t bufferBytes = 0;
#ifndef GCD_BENCH_BASELINE
    std::string tracePath;
    std::unique_ptr<FileSink> sink;
    std::unique_ptr<EventBuffer> events;
    std::unique_ptr<RunnerObserver> observer;
    std::unique_ptr<TracingHeap> tracing;
#endif
};

struct Ctx {
    Env& env;
    Metrics& metrics;
    std::mt19937_64 rng;
    gc::IHeap& h() { return *env.api; }

    std::size_t pick(std::size_t bound) { return static_cast<std::size_t>(rng() % bound); }

    gc::ObjectHandle alloc() {
        ++metrics.allocations;
        return h().allocate();
    }
    void setField(gc::ObjectHandle object, const char* field, gc::ObjectHandle target) {
        ++metrics.fieldWrites;
        h().setField(object, field, target);
    }
    void collect() {
        const auto start = Clock::now();
        h().collect();
        const double ms = msSince(start);
        metrics.collectMs += ms;
        metrics.roundCollectMs.push_back(ms);
        ++metrics.collections;
        const gc::GCStats stats = h().getStats();
        metrics.freedTotal += stats.objectsCollectedLastRun;
        metrics.liveAfterLast = stats.liveObjectsAfterLastRun;
        metrics.maxLiveBefore = std::max<std::uint64_t>(
            metrics.maxLiveBefore, stats.liveObjectsAfterLastRun + stats.objectsCollectedLastRun);
        mixDigest(metrics, stats.objectsCollectedLastRun);
        mixDigest(metrics, stats.liveObjectsAfterLastRun);
    }
};

std::size_t scaled(std::size_t base, double scale) {
    return std::max<std::size_t>(1, static_cast<std::size_t>(static_cast<double>(base) * scale));
}

void w1(Ctx& c, double scale) {
    const std::size_t n = scaled(1000000, scale);
    std::size_t ring = 0;
    for (std::size_t i = 0; i < n; ++i) {
        const gc::ObjectHandle object = c.alloc();
        if (i % 100 == 0) {
            c.h().setRoot("ring-" + std::to_string(ring++ % 1000), object);
        }
        if ((i + 1) % 10000 == 0) {
            c.collect();
        }
    }
    c.collect();
}

void w2(Ctx& c, double scale) {
    const std::size_t n = scaled(100000, scale);
    for (int round = 0; round < 20; ++round) {
        gc::ObjectHandle previous = c.alloc();
        c.h().setRoot("head", previous);
        for (std::size_t i = 1; i < n; ++i) {
            const gc::ObjectHandle current = c.alloc();
            c.setField(previous, "next", current);
            previous = current;
        }
        c.collect();  // list alive: deep mark
        c.h().clearRoot("head");
        c.collect();  // list dead: sweep
    }
}

void w3(Ctx& c, double scale) {
    const int depth = scale < 1.0 ? 12 : 16;
    std::vector<gc::ObjectHandle> level;
    const gc::ObjectHandle root = c.alloc();
    c.h().setRoot("tree", root);
    level.push_back(root);
    for (int d = 1; d < depth; ++d) {
        std::vector<gc::ObjectHandle> next;
        for (const gc::ObjectHandle parent : level) {
            const gc::ObjectHandle left = c.alloc();
            const gc::ObjectHandle right = c.alloc();
            c.setField(parent, "l", left);
            c.setField(parent, "r", right);
            next.push_back(left);
            next.push_back(right);
        }
        level.swap(next);
    }
    const auto subtree = [&c](int levels) {
        std::vector<gc::ObjectHandle> frontier;
        const gc::ObjectHandle top = c.alloc();
        frontier.push_back(top);
        for (int d = 1; d < levels; ++d) {
            std::vector<gc::ObjectHandle> next;
            for (const gc::ObjectHandle parent : frontier) {
                const gc::ObjectHandle left = c.alloc();
                const gc::ObjectHandle right = c.alloc();
                c.setField(parent, "l", left);
                c.setField(parent, "r", right);
                next.push_back(left);
                next.push_back(right);
            }
            frontier.swap(next);
        }
        return top;
    };
    for (int round = 0; round < 20; ++round) {
        for (int replacement = 0; replacement < 8; ++replacement) {
            gc::ObjectHandle node = root;
            const std::size_t walk = 3 + c.pick(static_cast<std::size_t>(depth - 6));
            for (std::size_t step = 0; step < walk; ++step) {
                const gc::ObjectHandle next = c.h().getField(node, c.pick(2) == 0 ? "l" : "r");
                if (!next.isValid()) {
                    break;
                }
                node = next;
            }
            c.setField(node, c.pick(2) == 0 ? "l" : "r", subtree(8));
        }
        c.collect();
    }
}

void w4(Ctx& c, double scale) {
    const std::size_t cycles = scaled(10000, scale);
    for (std::size_t i = 0; i < cycles; ++i) {
        const std::size_t length = 2 + c.pick(4);
        std::vector<gc::ObjectHandle> members;
        for (std::size_t k = 0; k < length; ++k) {
            members.push_back(c.alloc());
        }
        for (std::size_t k = 0; k < length; ++k) {
            c.setField(members[k], "next", members[(k + 1) % length]);
        }
        c.h().setRoot("c-" + std::to_string(i), members[0]);
    }
    c.collect();
    for (std::size_t i = 0; i < cycles; i += 2) {
        c.h().clearRoot("c-" + std::to_string(i));
    }
    c.collect();
    for (std::size_t i = 1; i < cycles; i += 2) {
        c.h().clearRoot("c-" + std::to_string(i));
    }
    c.collect();
}

void w5(Ctx& c, double scale) {
    const std::size_t n = scaled(10000, scale > 1.0 ? scale : 1.0);
    const std::size_t writes = scaled(1000000, scale);
    std::vector<gc::ObjectHandle> objects;
    for (std::size_t i = 0; i < n; ++i) {
        objects.push_back(c.alloc());
        c.h().setRoot("o-" + std::to_string(i), objects.back());
    }
    static const char* const fields[4] = {"f0", "f1", "f2", "f3"};
    for (std::size_t i = 0; i < writes; ++i) {
        const gc::ObjectHandle source = objects[c.pick(n)];
        const bool clear = c.pick(16) == 0;
        c.setField(source, fields[c.pick(4)], clear ? gc::ObjectHandle::invalid() : objects[c.pick(n)]);
        if ((i + 1) % 250000 == 0) {
            c.collect();
        }
    }
    c.collect();
}

void w6(Ctx& c, double scale) {
    const std::size_t garbage = scaled(1000000, scale);
    c.h().setRoot("live", c.alloc());
    for (int round = 0; round < 6; ++round) {
        for (std::size_t i = 0; i < garbage; ++i) {
            c.alloc();
        }
        c.collect();
    }
}

void w7(Ctx& c, double scale) {
    const std::size_t n = scaled(100000, scale);
    const gc::ObjectHandle hub = c.alloc();
    c.h().setRoot("hub", hub);
    for (std::size_t i = 0; i < n; ++i) {
        const gc::ObjectHandle referrer = c.alloc();
        c.setField(referrer, "hub", hub);
        c.h().setRoot("r-" + std::to_string(i), referrer);
    }
    c.h().clearRoot("hub");
    c.collect();
    const std::size_t step = std::max<std::size_t>(1, n / 10);
    for (std::size_t start = 0; start < n; start += step) {
        for (std::size_t i = start; i < std::min(n, start + step); ++i) {
            c.h().clearRoot("r-" + std::to_string(i));
        }
        c.collect();
    }
}

using Workload = void (*)(Ctx&, double);

Workload workloadByName(const std::string& name) {
    if (name == "W1") return w1;
    if (name == "W2") return w2;
    if (name == "W3") return w3;
    if (name == "W4") return w4;
    if (name == "W5") return w5;
    if (name == "W6") return w6;
    if (name == "W7") return w7;
    return nullptr;
}

Metrics runOnce(Workload workload, const Variant& variant, std::uint64_t seed, double scale,
                const std::string& scratch) {
    Metrics metrics;
    Env env(variant, scratch);
    Ctx ctx{env, metrics, std::mt19937_64(seed)};
    const auto start = Clock::now();
    workload(ctx, scale);
#ifndef GCD_BENCH_BASELINE
    if (env.events) {
        env.events->finish();
    }
#endif
    metrics.totalMs = msSince(start);
    metrics.bufferBytes = env.bufferBytes;
#ifndef GCD_BENCH_BASELINE
    std::uint64_t markNs = 0, sweepNs = 0, fields = 0, slots = 0, marked = 0;
    for (const auto& record : env.heap->diagnostics().collections) {
        markNs += record.markNs;
        sweepNs += record.sweepNs;
        fields += record.fieldsScanned;
        slots += record.slotsScanned;
        marked += record.marked;
    }
    metrics.markMs = static_cast<double>(markNs) / 1e6;
    metrics.sweepMs = static_cast<double>(sweepNs) / 1e6;
    metrics.fieldsScanned = static_cast<std::int64_t>(fields);
    metrics.slotsScanned = static_cast<std::int64_t>(slots);
    metrics.marked = static_cast<std::int64_t>(marked);
    metrics.staleWritesRejected = static_cast<std::int64_t>(env.heap->diagnostics().staleWritesRejected);
    if (variant.regionSize != 0) {
        const memory::RegionGraph graph = env.heap->regionGraph(false);
        metrics.metadataBytes = graph.regions.size() * sizeof(memory::RegionStats) +
                                graph.edges.size() * (sizeof(std::uint64_t) + sizeof(std::uint32_t) + 24);
    }
    if (env.events) {
        const TraceSummary summary = env.events->summary();
        metrics.traceEvents = summary.eventCount;
        metrics.traceDropped = summary.droppedCount;
        metrics.traceBatches = summary.batchCount;
        std::error_code ignored;
        metrics.traceBytes = std::filesystem::file_size(env.tracePath, ignored);
        std::filesystem::remove(env.tracePath, ignored);
    }
#endif
    return metrics;
}

std::string json(const std::string& value) {
    std::string out = "\"";
    for (const char ch : value) {
        if (ch == '"' || ch == '\\') {
            out += '\\';
        }
        out += ch;
    }
    return out + "\"";
}

void writeMetrics(std::ostream& out, const Metrics& m, int iteration, bool warmup) {
    out << "{\"iteration\":" << iteration << ",\"warmup\":" << (warmup ? "true" : "false")
        << ",\"totalMs\":" << m.totalMs << ",\"collectMs\":" << m.collectMs
        << ",\"markMs\":" << m.markMs << ",\"sweepMs\":" << m.sweepMs
        << ",\"allocations\":" << m.allocations << ",\"fieldWrites\":" << m.fieldWrites
        << ",\"collections\":" << m.collections << ",\"freedTotal\":" << m.freedTotal
        << ",\"liveAfterLast\":" << m.liveAfterLast << ",\"maxLiveBefore\":" << m.maxLiveBefore
        << ",\"marked\":" << m.marked << ",\"fieldsScanned\":" << m.fieldsScanned
        << ",\"slotsScanned\":" << m.slotsScanned
        << ",\"staleWritesRejected\":" << m.staleWritesRejected
        << ",\"traceEvents\":" << m.traceEvents << ",\"traceDropped\":" << m.traceDropped
        << ",\"traceBatches\":" << m.traceBatches << ",\"traceBytes\":" << m.traceBytes
        << ",\"bufferBytes\":" << m.bufferBytes << ",\"metadataBytes\":" << m.metadataBytes
        << ",\"digest\":\"" << m.digest << "\",\"roundCollectMs\":[";
    for (std::size_t i = 0; i < m.roundCollectMs.size(); ++i) {
        out << (i ? "," : "") << m.roundCollectMs[i];
    }
    out << "]}";
}

std::string environmentJson() {
    std::ostringstream out;
    out << "\"compiler\":" << json(
#if defined(__clang__)
        std::string("clang ") + __clang_version__
#elif defined(__GNUC__)
        std::string("gcc ") + __VERSION__
#else
        "unknown"
#endif
    );
#ifdef NDEBUG
    out << ",\"ndebug\":true";
#else
    out << ",\"ndebug\":false";
#endif
    out << ",\"objectBytes\":" << sizeof(memory::Object);
    return out.str();
}

std::int64_t peakRssBytes() {
    rusage usage{};
    getrusage(RUSAGE_SELF, &usage);
#ifdef __APPLE__
    return usage.ru_maxrss;  // bytes on macOS
#else
    return static_cast<std::int64_t>(usage.ru_maxrss) * 1024;  // KiB on Linux
#endif
}

#ifndef GCD_BENCH_BASELINE
// H2: cost of a bounded region overview (a) built from a full snapshot (view + aggregation)
// versus (b) exported from the RegionTable.
int runH2(std::size_t n, int reps, const std::string& out) {
    memory::Heap::Options options;
    options.regionSize = 64;
    memory::Heap heap(options);
    std::mt19937_64 rng(7);
    std::vector<gc::ObjectHandle> objects;
    objects.reserve(n);
    for (std::size_t i = 0; i < n; ++i) {
        objects.push_back(heap.allocate());
        if (i > 0) {
            heap.setField(objects[i], "a", objects[rng() % i]);
            if (rng() % 2 == 0) {
                heap.setField(objects[i], "b", objects[rng() % i]);
            }
        }
    }
    heap.setRoot("root", objects[0]);
    std::vector<double> snapshotMs, exportMs;
    std::uint64_t snapshotBytes = 0, exportBytes = 0, sink = 0;
    for (int rep = 0; rep < reps; ++rep) {
        auto start = Clock::now();
        const memory::HeapView view = heap.view();
        std::unordered_map<std::uint64_t, std::uint64_t> live, cross;
        std::uint64_t bytes = 0;
        for (const auto& object : view.objects()) {
            ++live[object.slot / 64];
            bytes += sizeof(object);
            for (const auto& field : object.fields) {
                bytes += sizeof(field) + field.name.size();
                if (field.target.isValid()) {
                    const std::uint64_t to = field.target.raw() / 64;
                    const std::uint64_t from = object.slot / 64;
                    if (from != to) {
                        ++cross[(from << 32) | to];
                    }
                }
            }
        }
        sink += live.size() + cross.size();
        snapshotMs.push_back(msSince(start));
        snapshotBytes = bytes;

        start = Clock::now();
        const memory::RegionGraph graph = heap.regionGraph(false);
        sink += graph.regions.size() + graph.edges.size();
        exportMs.push_back(msSince(start));
        exportBytes = graph.regions.size() * sizeof(memory::RegionInfo) +
                      graph.edges.size() * sizeof(memory::RegionEdge);
    }
    std::ofstream file(out);
    file << "{\"kind\":\"h2\",\"objects\":" << n << ",\"reps\":" << reps << ",\"sink\":" << sink
         << ",\"snapshotBytes\":" << snapshotBytes << ",\"exportBytes\":" << exportBytes
         << ",\"snapshotMs\":[";
    for (std::size_t i = 0; i < snapshotMs.size(); ++i) file << (i ? "," : "") << snapshotMs[i];
    file << "],\"exportMs\":[";
    for (std::size_t i = 0; i < exportMs.size(); ++i) file << (i ? "," : "") << exportMs[i];
    file << "]}\n";
    return file ? 0 : 3;
}
#endif

} // namespace

int main(int argc, char** argv) {
    std::string workloadName, variantName = "Aprime", out, scratch = "/tmp";
    int warmup = 5, measure = 10;
    std::uint64_t seed = 1;
    double scale = 1.0;
    long h2Objects = 0;
    int h2Reps = 10;
    for (int i = 1; i + 1 < argc; i += 2) {
        const std::string flag = argv[i];
        const std::string value = argv[i + 1];
        if (flag == "--workload") workloadName = value;
        else if (flag == "--variant") variantName = value;
        else if (flag == "--warmup") warmup = std::atoi(value.c_str());
        else if (flag == "--measure") measure = std::atoi(value.c_str());
        else if (flag == "--seed") seed = std::strtoull(value.c_str(), nullptr, 10);
        else if (flag == "--scale") scale = std::atof(value.c_str());
        else if (flag == "--out") out = value;
        else if (flag == "--scratch") scratch = value;
        else if (flag == "--h2") h2Objects = std::atol(value.c_str());
        else if (flag == "--reps") h2Reps = std::atoi(value.c_str());
        else { std::cerr << "unknown flag " << flag << '\n'; return 3; }
    }
    if (out.empty()) {
        std::cerr << "--out is required\n";
        return 3;
    }
#ifndef GCD_BENCH_BASELINE
    if (h2Objects > 0) {
        return runH2(static_cast<std::size_t>(h2Objects), h2Reps, out);
    }
#else
    (void)h2Objects;
    (void)h2Reps;
#endif
    const Workload workload = workloadByName(workloadName);
    const auto variants = allVariants();
    const auto found = std::find_if(variants.begin(), variants.end(),
                                    [&](const Variant& v) { return v.name == variantName; });
    if (workload == nullptr || found == variants.end()) {
        std::cerr << "unknown workload or variant\n";
        return 3;
    }
#ifdef GCD_BENCH_BASELINE
    if (!found->baseline) {
        std::cerr << "the baseline build only supports variant A\n";
        return 3;
    }
#else
    if (found->baseline) {
        std::cerr << "variant A must be built with -DGCD_BENCH_BASELINE from the v1-baseline tree\n";
        return 3;
    }
#endif
    std::filesystem::create_directories(scratch);
    std::ostringstream body;
    for (int iteration = 0; iteration < warmup + measure; ++iteration) {
        const Metrics metrics = runOnce(workload, *found, seed, scale, scratch);
        if (iteration > 0) body << ",\n";
        writeMetrics(body, metrics, iteration, iteration < warmup);
    }
    std::ofstream file(out);
    file << "{\"kind\":\"collector\",\"workload\":" << json(workloadName)
         << ",\"variant\":" << json(variantName) << ",\"seed\":" << seed << ",\"scale\":" << scale
         << ",\"warmup\":" << warmup << ",\"measure\":" << measure
         << ",\"peakRssBytes\":" << peakRssBytes() << "," << environmentJson()
         << ",\"iterations\":[\n" << body.str() << "\n]}\n";
    return file ? 0 : 3;
}
