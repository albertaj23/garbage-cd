#include "check.hpp"

#include <cstdint>
#include <iostream>
#include <regex>
#include <string>
#include <vector>

#include "event_buffer.hpp"

namespace {

std::vector<std::uint64_t> eventSequences(const std::vector<std::string>& lines) {
    const std::regex sequencePattern(R"(\[([0-9]+),"[A-Z]{1,2}",)");
    std::vector<std::uint64_t> sequences;
    for (const std::string& line : lines) {
        for (std::sregex_iterator it(line.begin(), line.end(), sequencePattern), end;
             it != end; ++it) {
            sequences.push_back(std::stoull((*it)[1].str()));
        }
    }
    return sequences;
}

void testBatchBoundaries(std::size_t batchCapacity, std::size_t expectedBatches) {
    MemorySink sink;
    EventBuffer events(sink, "run", batchCapacity, TraceLevel::Mutator);
    for (std::uint64_t i = 0; i < 10; ++i) {
        events.allocation(3, gc::ObjectHandle(static_cast<std::size_t>(i)));
    }
    events.finish();

    CHECK_EQ(sink.lines().size(), expectedBatches + 1);
    CHECK_EQ(events.summary().batchCount, expectedBatches);
    CHECK_EQ(events.summary().eventCount, 10U);
    CHECK(events.summary().complete);
    const auto sequences = eventSequences(sink.lines());
    CHECK_EQ(sequences.size(), 10U);
    for (std::size_t i = 0; i < sequences.size(); ++i) {
        CHECK_EQ(sequences[i], i + 1);
    }
    CHECK(sink.lines().back().find("\"type\":\"end\"") != std::string::npos);
    CHECK(sink.lines().back().find("\"lastSeq\":10") != std::string::npos);
}

void testOverflowKeepsStructuralEventsAndCountsDrops() {
    MemorySink sink;
    EventBuffer events(sink, "overflow", 2, TraceLevel::Full, 3, 1024 * 1024);
    events.allocation(1, gc::ObjectHandle(1));
    events.allocation(1, gc::ObjectHandle(2));
    events.allocation(1, gc::ObjectHandle(3));
    events.allocation(1, gc::ObjectHandle(4));
    events.statementBegin(2);
    events.statementEnd(2);
    events.collectionBegin(2, 1);
    memory::CollectionRecord record;
    record.gcIndex = 1;
    record.freed = 2;
    record.liveAfter = 1;
    events.collectionEnd(2, record);
    events.finish();

    const auto summary = events.summary();
    CHECK(!summary.complete);
    CHECK_EQ(summary.eventCount, 7U);
    CHECK_EQ(summary.droppedCount, 1U);
    CHECK_EQ(summary.droppedByKind.at("A"), 1U);
    const auto sequences = eventSequences(sink.lines());
    CHECK_EQ(sequences.size(), 7U);
    for (std::size_t i = 0; i < sequences.size(); ++i) {
        CHECK_EQ(sequences[i], i + 1);
    }
    const std::string& trailer = sink.lines().back();
    CHECK(trailer.find("\"complete\":false") != std::string::npos);
    CHECK(trailer.find("\"A\":1") != std::string::npos);
}

void testByteCapStillRetainsStructuralEvents() {
    MemorySink sink;
    EventBuffer events(sink, "byte-cap", 16, TraceLevel::Full, 100, 1);
    events.allocation(1, gc::ObjectHandle(1));
    events.statementBegin(2);
    events.collectionBegin(2, 1);
    memory::CollectionRecord record;
    record.gcIndex = 1;
    events.collectionEnd(2, record);
    events.finish();

    const auto summary = events.summary();
    CHECK(!summary.complete);
    CHECK_EQ(summary.droppedCount, 1U);
    CHECK_EQ(summary.eventCount, 3U);
    const auto sequences = eventSequences(sink.lines());
    CHECK_EQ(sequences.size(), 3U);
    CHECK(sink.lines().back().find("\"complete\":false") != std::string::npos);
}

void testTraceLevelSelection() {
    MemorySink gcSink;
    EventBuffer gcEvents(gcSink, "gc", 20, TraceLevel::Gc);
    gcEvents.statementBegin(1);
    gcEvents.allocation(1, gc::ObjectHandle(1));
    gcEvents.statementEnd(1);
    gcEvents.finish();
    CHECK_EQ(gcEvents.summary().eventCount, 2U);
    CHECK(gcSink.lines().front().find("\"SB\"") != std::string::npos);
    CHECK(gcSink.lines().front().find("\"SE\"") != std::string::npos);
    CHECK(gcSink.lines().front().find("\"A\"") == std::string::npos);

    MemorySink fullSink;
    EventBuffer fullEvents(fullSink, "full", 20, TraceLevel::Full);
    memory::MarkDiscovery discovery;
    discovery.root = "root";
    fullEvents.markVisit(1, gc::ObjectHandle(1), discovery);
    fullEvents.sweepFree(1, gc::ObjectHandle(2));
    fullEvents.finish();
    CHECK_EQ(fullEvents.summary().eventCount, 2U);
    CHECK(fullSink.lines().front().find("\"MV\"") != std::string::npos);
    CHECK(fullSink.lines().front().find("\"SF\"") != std::string::npos);
    CHECK(fullSink.lines().front().find("\"root\"") != std::string::npos);
}

} // namespace

int main() {
    testBatchBoundaries(1, 10);
    testBatchBoundaries(3, 4);
    testBatchBoundaries(1024, 1);
    testOverflowKeepsStructuralEventsAndCountsDrops();
    testByteCapStillRetainsStructuralEvents();
    testTraceLevelSelection();
    std::cout << "event_buffer_tests: all checks passed\n";
}
