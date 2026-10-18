#include "region_writer.hpp"

#include <filesystem>
#include <fstream>

#include "json_writer.hpp"

RegionGraphWriter::RegionGraphWriter(std::string directory, std::string runId)
    : directory_(std::move(directory)), runId_(std::move(runId)) {}

std::string RegionGraphWriter::serialize(const std::string& point,
                                         const memory::RegionGraph& graph,
                                         std::optional<std::uint64_t> gcIndex,
                                         std::uint32_t statementIndex,
                                         std::uint64_t index) const {
    JsonWriter json;
    json.beginObject();
    json.key("schema");
    json.string("gcd.region-graph/1");
    json.key("runId");
    json.string(runId_);
    json.key("index");
    json.number(index);
    json.key("point");
    json.string(point);
    json.key("regionSize");
    json.number(static_cast<std::uint64_t>(graph.regionSize));
    json.key("gcIndex");
    if (gcIndex) {
        json.number(*gcIndex);
    } else {
        json.nullValue();
    }
    json.key("statementIndex");
    json.number(static_cast<std::uint64_t>(statementIndex));
    json.key("verified");
    json.boolean(graph.verified);
    json.key("regions");
    json.beginArray();
    for (const auto& region : graph.regions) {
        json.beginObject();
        json.key("id");
        json.number(region.id);
        json.key("slotStart");
        json.number(region.slotStart);
        json.key("slotEnd");
        json.number(region.slotEnd);
        json.key("liveObjects");
        json.number(region.stats.liveObjects);
        json.key("allocatedTotal");
        json.number(region.stats.allocatedTotal);
        json.key("survivorsLastGc");
        json.number(region.stats.survivorsLastGc);
        json.key("freedLastGc");
        json.number(region.stats.freedLastGc);
        json.key("rootTargets");
        json.number(region.rootTargets);
        json.key("intraEdges");
        json.number(region.stats.intraEdges);
        json.endObject();
    }
    json.endArray();
    json.key("edges");
    json.beginArray();
    for (const auto& edge : graph.edges) {
        json.beginObject();
        json.key("from");
        json.number(edge.from);
        json.key("to");
        json.number(edge.to);
        json.key("count");
        json.number(edge.count);
        json.endObject();
    }
    json.endArray();
    json.endObject();
    return json.str();
}

RegionGraphRecord RegionGraphWriter::write(const std::string& point,
                                           const memory::RegionGraph& graph,
                                           std::optional<std::uint64_t> gcIndex,
                                           std::uint32_t statementIndex) {
    RegionGraphRecord record;
    record.index = nextIndex_++;
    record.gcIndex = gcIndex;
    record.point = point;
    record.regionCount = graph.regions.size();
    record.verified = graph.verified;
    const std::filesystem::path outputPath =
        std::filesystem::path(directory_) / ("region-" + std::to_string(record.index) + ".json");
    try {
        std::filesystem::create_directories(directory_);
        const std::filesystem::path temporaryPath = outputPath.string() + ".tmp";
        {
            std::ofstream output(temporaryPath, std::ios::binary | std::ios::trunc);
            if (!output) {
                throw std::runtime_error("unable to open region graph output");
            }
            output << serialize(point, graph, gcIndex, statementIndex, record.index) << '\n';
            output.flush();
            if (!output) {
                throw std::runtime_error("unable to write region graph output");
            }
        }
        std::error_code error;
        std::filesystem::rename(temporaryPath, outputPath, error);
        if (error) {
            std::filesystem::remove(temporaryPath);
            throw std::runtime_error("unable to publish region graph: " + error.message());
        }
        records_.push_back(record);
    } catch (const std::exception& exception) {
        error_ = exception.what();
    }
    return record;
}
