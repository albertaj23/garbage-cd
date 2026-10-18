#include "check.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>

#include "memory/heap.hpp"
#include "snapshot_writer.hpp"

namespace {

std::size_t occurrences(const std::string& text, const std::string& needle) {
    std::size_t count = 0;
    std::size_t position = 0;
    while ((position = text.find(needle, position)) != std::string::npos) {
        ++count;
        position += needle.size();
    }
    return count;
}

void testBoundedBreadthFirstSnapshot() {
    memory::Heap heap;
    gc::ObjectHandle objects[7];
    for (auto& object : objects) {
        object = heap.allocate();
    }
    heap.setField(objects[4], "next", objects[5]);
    heap.setField(objects[5], "next", objects[6]);
    heap.setRoot("root", objects[4]);

    SnapshotWriter writer("/tmp/gcd-snapshot-test", "run", 2);
    bool truncated = false;
    const std::string markComplete =
        writer.serialize("mark_complete", heap.view(), 1, 3, 0, truncated);
    CHECK(truncated);
    CHECK(markComplete.find("\"totalObjects\":7") != std::string::npos);
    CHECK(markComplete.find("\"truncated\":true") != std::string::npos);
    CHECK(markComplete.find("\"target\":\"4\"") != std::string::npos);
    CHECK(markComplete.find("\"id\":\"4\"") != std::string::npos);
    CHECK(markComplete.find("\"id\":\"5\"") != std::string::npos);
    CHECK(markComplete.find("\"id\":\"0\"") == std::string::npos);
    CHECK_EQ(occurrences(markComplete, "\"id\":"), 2U);

    const std::string programEnd =
        writer.serialize("program_end", heap.view(), std::nullopt, 7, 1, truncated);
    CHECK(programEnd.find("\"gcIndex\":null") != std::string::npos);
    CHECK(programEnd.find("\"marked\":null") != std::string::npos);
    CHECK(truncated);
}

void testSnapshotFileWrite() {
    const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
    const std::filesystem::path directory =
        std::filesystem::temp_directory_path() / ("gcd-snapshot-" + std::to_string(suffix));
    memory::Heap heap;
    heap.allocate();
    SnapshotWriter writer(directory.string(), "run", 2000);
    const auto record = writer.write("program_end", heap.view(), std::nullopt, 0);
    CHECK(writer.error().empty());
    CHECK_EQ(writer.records().size(), 1U);
    CHECK_EQ(record.index, 0U);
    std::ifstream input(record.path, std::ios::binary);
    CHECK(static_cast<bool>(input));
    const std::string content((std::istreambuf_iterator<char>(input)),
                              std::istreambuf_iterator<char>());
    CHECK(content.find("\"schema\":\"gcd.heap-snapshot/1\"") != std::string::npos);
    std::filesystem::remove_all(directory);
}

} // namespace

int main() {
    testBoundedBreadthFirstSnapshot();
    testSnapshotFileWrite();
    std::cout << "snapshot_tests: all checks passed\n";
}
