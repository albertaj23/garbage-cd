option(GCD_SANITIZE "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang|AppleClang")
    target_compile_options(gc_tests PRIVATE -UNDEBUG)
    target_compile_options(interpreter_tests PRIVATE -UNDEBUG)
endif()

if(GCD_SANITIZE)
    get_property(GCD_EXISTING_TARGETS DIRECTORY PROPERTY BUILDSYSTEM_TARGETS)
    foreach(target IN LISTS GCD_EXISTING_TARGETS)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${target} PRIVATE -fsanitize=address,undefined)
    endforeach()
endif()

function(gcd_v2_add_executable target source)
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/${source}")
        set(target_sources "${source}" ${ARGN} ${CORE_SOURCES})
        if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/src/memory/diagnostics.cpp")
            list(APPEND target_sources src/memory/diagnostics.cpp)
        endif()

        add_executable(${target} ${target_sources})
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
        if(GCD_SANITIZE)
            target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
            target_link_options(${target} PRIVATE -fsanitize=address,undefined)
        endif()
    endif()
endfunction()

gcd_v2_add_executable(gcd_v2_canary tests/v2/canary_test.cpp)
if(TARGET gcd_v2_canary)
    add_test(
        NAME gcd_v2_canary
        COMMAND bash -c
                "\"$1\" >/dev/null 2>&1; status=$?; if [ \"$status\" -ne 0 ]; then exit 1; else exit 0; fi"
                bash "$<TARGET_FILE:gcd_v2_canary>")
    set_tests_properties(gcd_v2_canary PROPERTIES WILL_FAIL TRUE)
endif()

gcd_v2_add_executable(gc_correctness_tests tests/v2/gc_correctness_tests.cpp)
gcd_v2_add_executable(gc_property_tests tests/v2/gc_property_tests.cpp)
gcd_v2_add_executable(diagnostics_tests tests/v2/diagnostics_tests.cpp)
gcd_v2_add_executable(region_tests tests/v2/region_tests.cpp)
gcd_v2_add_executable(handle_reuse_tests tests/v2/handle_reuse_tests.cpp)
gcd_v2_add_executable(differential_tests tests/v2/differential_tests.cpp)
gcd_v2_add_executable(
    event_buffer_tests tests/v2/event_buffer_tests.cpp
    tools/gcd_runner/event_buffer.cpp)
if(TARGET event_buffer_tests)
    target_include_directories(event_buffer_tests PRIVATE tools/gcd_runner)
endif()
gcd_v2_add_executable(
    snapshot_tests tests/v2/snapshot_tests.cpp
    tools/gcd_runner/snapshot_writer.cpp)
if(TARGET snapshot_tests)
    target_include_directories(snapshot_tests PRIVATE tools/gcd_runner)
endif()
gcd_v2_add_executable(
    gcd_runner tools/gcd_runner/main.cpp
    tools/gcd_runner/event_buffer.cpp
    tools/gcd_runner/snapshot_writer.cpp
    tools/gcd_runner/region_writer.cpp
    tools/gcd_runner/tracing_heap.cpp
    tools/gcd_runner/spans.cpp
    tools/gcd_runner/toy_ast_json.cpp)

if(TARGET gcd_runner)
    execute_process(
        COMMAND git rev-parse --short=12 HEAD
        WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
        OUTPUT_VARIABLE GCD_GIT_COMMIT
        OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE GCD_GIT_RESULT
        ERROR_QUIET)
    if(NOT GCD_GIT_RESULT EQUAL 0)
        set(GCD_GIT_COMMIT "unknown")
    endif()
    target_compile_definitions(gcd_runner PRIVATE GCD_GIT_COMMIT="${GCD_GIT_COMMIT}")
endif()

foreach(test_target IN ITEMS gc_correctness_tests gc_property_tests diagnostics_tests
                            event_buffer_tests snapshot_tests region_tests handle_reuse_tests
                            differential_tests)
    if(TARGET ${test_target})
        add_test(NAME ${test_target} COMMAND ${test_target})
    endif()
endforeach()

if(TARGET gcd_runner AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/tests/v2/runner_tests.sh")
    find_program(GCD_NODE_EXECUTABLE
        NAMES node
        PATHS /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin
        NO_DEFAULT_PATH)
    if(NOT GCD_NODE_EXECUTABLE)
        find_program(GCD_NODE_EXECUTABLE NAMES node)
    endif()
    add_test(
        NAME runner_tests
        COMMAND ${CMAKE_COMMAND} -E env
                "NODE=${GCD_NODE_EXECUTABLE}" "CXX=${CMAKE_CXX_COMPILER}"
                bash "${CMAKE_CURRENT_SOURCE_DIR}/tests/v2/runner_tests.sh"
                "$<TARGET_FILE:gcd_runner>" "$<TARGET_FILE:garbage_cd>")
endif()
