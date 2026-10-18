cmake_minimum_required(VERSION 3.15)
project(garbage_cd CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include_directories(${CMAKE_SOURCE_DIR}/include)

set(CORE_SOURCES
    src/interpreter/lexer.cpp
    src/interpreter/parser.cpp
    src/interpreter/interpreter.cpp
    src/runtime/value.cpp
    src/runtime/environment.cpp
    src/memory/object.cpp
    src/memory/heap.cpp
    src/memory/mark.cpp
    src/memory/sweep.cpp
)

add_executable(garbage_cd src/main.cpp ${CORE_SOURCES})

enable_testing()

add_executable(interpreter_tests tests/interpreter_tests.cpp ${CORE_SOURCES})
add_executable(gc_tests tests/gc_tests.cpp ${CORE_SOURCES})

add_test(NAME interpreter_tests COMMAND interpreter_tests)
add_test(NAME gc_tests COMMAND gc_tests)

option(GCD_V2 "Build V2 tooling" ON)
if(GCD_V2)
  include(${CMAKE_SOURCE_DIR}/cmake/gcd_v2.cmake)
endif()
