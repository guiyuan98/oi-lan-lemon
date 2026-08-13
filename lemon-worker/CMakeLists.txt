add_executable(lemon-headless main.cpp)
target_precompile_headers(lemon-headless REUSE_FROM lemon-core)
target_include_directories(lemon-headless PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_BINARY_DIR}
    ${spdlog_DIR}/include
)
target_link_libraries(lemon-headless PRIVATE
    lemon-core
    lemon-base
    SingleApplication::SingleApplication
    ${LEMON_QT_LIBS}
    spdlog::spdlog
)
