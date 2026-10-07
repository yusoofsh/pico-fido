#
# This file is part of the Pico FIDO distribution (https://github.com/polhenarejos/pico-fido).
# Copyright (c) 2022 Pol Henarejos.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, version 3.
#
# This program is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <http://www.gnu.org/licenses/>.
#

cmake_minimum_required(VERSION 3.13)

set(USB_VID 0x2E8A)
set(USB_PID 0x10FE)

if(ESP_PLATFORM)
    set(PICOKEYS_COMPONENTS fido)
    include($ENV{IDF_PATH}/tools/cmake/project.cmake)
else()
    if(NOT ENABLE_EMULATION)
        # Boards that are unstable at the fastest clock (200 MHz on RP2040) can
        # build with -DPICO_USE_FASTEST_SUPPORTED_CLOCK=0.
        if(NOT DEFINED PICO_USE_FASTEST_SUPPORTED_CLOCK)
            set(PICO_USE_FASTEST_SUPPORTED_CLOCK 1)
        endif()
        include(pico_sdk_import.cmake)
    endif()

    project(pico_fido C CXX ASM)

    set(CMAKE_C_STANDARD 11)
    set(CMAKE_CXX_STANDARD 17)

    add_executable(pico_fido)
endif()

include(pico-keys-sdk/cmake/options.cmake)

option(ENABLE_POWER_ON_RESET "Enable/disable power cycle on reset" ON)
configure_bool_option(
    ENABLE_POWER_ON_RESET
    ENABLE_POWER_ON_RESET
    "Power cycle on reset: \t enabled"
    "Power cycle on reset: \t disabled"
)

option(ENABLE_OATH_APP "Enable/disable OATH application" ON)
configure_bool_option(
    ENABLE_OATH_APP
    ENABLE_OATH_APP
    "OATH Application: \t\t enabled"
    "OATH Application: \t\t disabled"
)

option(ENABLE_OTP_APP "Enable/disable OTP application" ON)
configure_bool_option(
    ENABLE_OTP_APP
    ENABLE_OTP_APP
    "OTP Application: \t\t enabled"
    "OTP Application: \t\t disabled"
)

# USR-button companion (F13-F16 macros): default ON in the Pipico preset.
# The OFF build is the budget baseline for scripts/pipico/check-budget.sh.
option(PIPICO_COMPANION "Enable/disable the USR-button companion" ON)
configure_bool_option(
    PIPICO_COMPANION
    PIPICO_COMPANION
    "Pipico companion: \t\t enabled"
    "Pipico companion: \t\t disabled"
)

if(FORBID_DISABLE_AUV)
    add_compile_definitions(FORBID_DISABLE_AUV=1)
endif()
if(DEFAULT_MCUV_NOT_REQUIRED)
    add_compile_definitions(DEFAULT_MCUV_NOT_REQUIRED=1)
endif()
if(DEFAULT_PIN_POLICY)
    add_compile_definitions(DEFAULT_PIN_POLICY=1)
endif()
if(MAX_PIN_RETRIES)
    add_compile_definitions(MAX_PIN_RETRIES=${MAX_PIN_RETRIES})
endif()
if(FORCE_BUTTON_WAIT)
    add_compile_definitions(FORCE_BUTTON_WAIT=1)
endif()

# Pipico branding: USB product string (SDK default when absent: "Pico Key").
# A phy-config usb_product still overrides it at runtime; VID/PID and the
# serial-number mechanism are unchanged.
add_compile_definitions(USB_PRODUCT_STRING="Yusoofs Pipico")

if(ENABLE_OTP_APP OR ENABLE_OATH_APP)
    set(USB_ITF_CCID 1)
    set(USB_ITF_WCID 1)
else()
    set(USB_ITF_CCID 0)
endif()

set(USB_ITF_HID 1)
include(pico-keys-sdk/picokeys_sdk_import.cmake)
SET_BUILD_NUMBER("${CMAKE_CURRENT_LIST_DIR}")

if(NOT ESP_PLATFORM)
    set(SOURCES ${PICOKEYS_SOURCES})
endif()

list(APPEND SOURCES
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/fido.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/object_authorization.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/object_provider.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/resident_container.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/files.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cmd_register.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cmd_authenticate.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cmd_version.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_reset.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_get_info.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_make_credential.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/event.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/known_apps.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_client_pin.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/credential.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_get_assertion.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_selection.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_cred_mgmt.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_config.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_vendor.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/fido_vault.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/cbor_large_blobs.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/management.c
    ${CMAKE_CURRENT_LIST_DIR}/src/fido/defs.c
)

if(ENABLE_OATH_APP)
    list(APPEND SOURCES
        ${CMAKE_CURRENT_LIST_DIR}/src/fido/oath_container.c
        ${CMAKE_CURRENT_LIST_DIR}/src/fido/oath.c
    )
endif()

if(ENABLE_OTP_APP)
    list(APPEND SOURCES
        ${CMAKE_CURRENT_LIST_DIR}/src/fido/otp_container.c
        ${CMAKE_CURRENT_LIST_DIR}/src/fido/otp.c
    )
endif()

SET_VERSION(ver_major ver_minor "${CMAKE_CURRENT_LIST_DIR}/src/fido/version.h")
if(ESP_PLATFORM)
    project(pico_fido)
endif()

set(INCLUDES ${INCLUDES}
    ${CMAKE_CURRENT_LIST_DIR}/src/fido
)

if(PIPICO_COMPANION)
    # The companion pure modules are linked into the firmware (ARM and
    # emulation alike); pipico.c itself carries only the pure core except
    # in device builds, where its PIPICO_DEVICE_BUILD part (GPIO24 glue,
    # strong picokey_early_init/picokey_task) is compiled.
    list(APPEND INCLUDES ${CMAKE_CURRENT_LIST_DIR}/src/pipico)
    list(APPEND SOURCES
        ${CMAKE_CURRENT_LIST_DIR}/src/pipico/gesture.c
        ${CMAKE_CURRENT_LIST_DIR}/src/pipico/kbd_arbiter.c
        ${CMAKE_CURRENT_LIST_DIR}/src/pipico/pipico.c
    )
    if(NOT ENABLE_EMULATION AND NOT ESP_PLATFORM)
        # The Pico SDK does not export a PICO_PLATFORM preprocessor macro
        # in this configuration, so the device build is identified the same
        # way main.c tells the device path apart: neither the emulation
        # host build nor the ESP port is enabled.
        set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/src/pipico/pipico.c
            PROPERTIES COMPILE_DEFINITIONS "PIPICO_DEVICE_BUILD=1")
    endif()
endif()

if(NOT ESP_PLATFORM)
    target_sources(pico_fido PUBLIC ${SOURCES})
    target_include_directories(pico_fido PUBLIC ${INCLUDES})

    set(COMMON_COMPILE_OPTIONS
        -Wall
    )
    target_compile_options(pico_fido PRIVATE ${COMMON_COMPILE_OPTIONS})

    picokeys_apply_strict_flags(
        SOURCES ${SOURCES}
        FILTER_REGEX "/src/fido/|/pico-keys-sdk/src/|/pico-keys-sdk/config/"
    )

    if(NOT MSVC)
        string(FIND ${CMAKE_C_COMPILER} ":" COMPILER_COLON)
        if(${COMPILER_COLON} GREATER_EQUAL 0)
            target_compile_options(pico_fido PRIVATE
                -Wno-error=use-after-free
            )
        endif()
    endif()

    if(ENABLE_EMULATION)
        enable_testing()
        if(NOT MSVC)
            set(EMULATION_NON_MSVC_COMPILE_OPTIONS
                -fdata-sections
                -ffunction-sections
            )
            target_compile_options(pico_fido PRIVATE ${EMULATION_NON_MSVC_COMPILE_OPTIONS})
        endif()

        if(APPLE)
            set(EMULATION_APPLE_LINK_OPTIONS
                -Wl,-dead_strip
            )
            target_link_options(pico_fido PRIVATE ${EMULATION_APPLE_LINK_OPTIONS})

            if(DEBUG_APDU)
                set(DEBUG_APDU_SANITIZER_OPTIONS
                    -fsanitize=address
                    -g
                    -O1
                    -fno-omit-frame-pointer
                )
                target_compile_options(pico_fido PRIVATE ${DEBUG_APDU_SANITIZER_OPTIONS})
                target_link_options(pico_fido PRIVATE ${DEBUG_APDU_SANITIZER_OPTIONS})
            endif()
        elseif(NOT MSVC)
            set(EMULATION_NON_APPLE_LINK_OPTIONS
                -Wl,--gc-sections
            )
            target_link_options(pico_fido PRIVATE ${EMULATION_NON_APPLE_LINK_OPTIONS})
        endif()

        target_link_libraries(pico_fido PRIVATE picokeys_sdk mbedtls)
        if(NOT MSVC)
            target_link_libraries(pico_fido PRIVATE pthread m)
        endif()

        add_executable(fido_object_provider_test
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_crypto_provider.c
            ${CMAKE_CURRENT_LIST_DIR}/src/fido/object_provider.c
            ${CMAKE_CURRENT_LIST_DIR}/tests/fido_object_provider_test.c
        )
        target_include_directories(fido_object_provider_test PRIVATE ${INCLUDES})
        if(MSVC)
            target_compile_options(fido_object_provider_test PRIVATE /W4 /WX)
        else()
            target_compile_options(fido_object_provider_test PRIVATE -Wall -Wextra -Werror)
        endif()
        target_link_libraries(fido_object_provider_test PRIVATE mbedtls)
        add_test(NAME fido_object_provider_test COMMAND fido_object_provider_test)

        add_executable(fido_object_authorization_test
            ${CMAKE_CURRENT_LIST_DIR}/src/fido/object_authorization.c
            ${CMAKE_CURRENT_LIST_DIR}/tests/fido_object_authorization_test.c
        )
        target_include_directories(fido_object_authorization_test PRIVATE ${INCLUDES})
        if(MSVC)
            target_compile_options(fido_object_authorization_test PRIVATE /W4 /WX)
        else()
            target_compile_options(fido_object_authorization_test PRIVATE -Wall -Wextra -Werror)
        endif()
        target_link_libraries(fido_object_authorization_test PRIVATE mbedtls)
        add_test(NAME fido_object_authorization_test COMMAND fido_object_authorization_test)

        add_executable(fido_resident_container_test
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_container.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_container_store.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_crypto_provider.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_policy.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_store_txn.c
            ${CMAKE_CURRENT_LIST_DIR}/src/fido/object_provider.c
            ${CMAKE_CURRENT_LIST_DIR}/src/fido/resident_container.c
            ${CMAKE_CURRENT_LIST_DIR}/tests/fido_resident_container_test.c
        )
        target_include_directories(fido_resident_container_test PRIVATE ${INCLUDES})
        if(MSVC)
            target_compile_options(fido_resident_container_test PRIVATE /W4 /WX)
        else()
            target_compile_options(fido_resident_container_test PRIVATE -Wall -Wextra -Werror)
        endif()
        target_link_libraries(fido_resident_container_test PRIVATE mbedtls)
        add_test(NAME fido_resident_container_test COMMAND fido_resident_container_test)

        add_executable(fido_oath_container_test
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_container.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_container_store.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_crypto_provider.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_policy.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_store_txn.c
            ${CMAKE_CURRENT_LIST_DIR}/src/fido/object_provider.c
            ${CMAKE_CURRENT_LIST_DIR}/src/fido/oath_container.c
            ${CMAKE_CURRENT_LIST_DIR}/tests/fido_oath_container_test.c
        )
        target_include_directories(fido_oath_container_test PRIVATE ${INCLUDES})
        if(MSVC)
            target_compile_options(fido_oath_container_test PRIVATE /W4 /WX)
        else()
            target_compile_options(fido_oath_container_test PRIVATE -Wall -Wextra -Werror)
        endif()
        target_link_libraries(fido_oath_container_test PRIVATE mbedtls)
        add_test(NAME fido_oath_container_test COMMAND fido_oath_container_test)

        add_executable(fido_otp_container_test
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_container.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_container_store.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_crypto_provider.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_policy.c
            ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/fs/object_store_txn.c
            ${CMAKE_CURRENT_LIST_DIR}/src/fido/object_provider.c
            ${CMAKE_CURRENT_LIST_DIR}/src/fido/otp_container.c
            ${CMAKE_CURRENT_LIST_DIR}/tests/fido_otp_container_test.c
        )
        target_include_directories(fido_otp_container_test PRIVATE ${INCLUDES})
        if(MSVC)
            target_compile_options(fido_otp_container_test PRIVATE /W4 /WX)
        else()
            target_compile_options(fido_otp_container_test PRIVATE -Wall -Wextra -Werror)
        endif()
        target_link_libraries(fido_otp_container_test PRIVATE mbedtls)
        add_test(NAME fido_otp_container_test COMMAND fido_otp_container_test)

        # Storage-locked dispatch regression: drives the real application
        # dispatchers with the storage locked (see docs/pipico/LAYOUT.md).
        # The SDK sources are linked without main.c so the test provides its
        # own entry point.
        # ${SOURCES} already holds the SDK sources (PICOKEYS_SOURCES) plus
        # the root application sources; drop the SDK main.c so the test
        # provides its own entry point.
        set(FIDO_STORAGE_LOCKED_TEST_SOURCES ${SOURCES})
        list(REMOVE_ITEM FIDO_STORAGE_LOCKED_TEST_SOURCES ${CMAKE_CURRENT_LIST_DIR}/pico-keys-sdk/src/main.c)
        add_executable(fido_storage_locked_test
            ${FIDO_STORAGE_LOCKED_TEST_SOURCES}
            ${CMAKE_CURRENT_LIST_DIR}/tests/fido_storage_locked_test.c
        )
        target_include_directories(fido_storage_locked_test PRIVATE ${INCLUDES})
        if(MSVC)
            target_compile_options(fido_storage_locked_test PRIVATE /W4 /WX)
        else()
            target_compile_options(fido_storage_locked_test PRIVATE -Wall -Wextra -Werror)
        endif()
        target_link_libraries(fido_storage_locked_test PRIVATE ${LIBRARIES})
        if(NOT MSVC)
            target_link_libraries(fido_storage_locked_test PRIVATE pthread m)
        endif()
        add_test(NAME fido_storage_locked_test COMMAND fido_storage_locked_test)

        # Pure gesture parser (USR button taps and holds): a time-injected
        # state machine with no SDK headers, one process per scenario so
        # ctest -R gesture selects them by name.
        add_executable(fido_gesture_test
            ${CMAKE_CURRENT_LIST_DIR}/src/pipico/gesture.c
            ${CMAKE_CURRENT_LIST_DIR}/tests/fido_gesture_test.c
        )
        target_include_directories(fido_gesture_test PRIVATE ${CMAKE_CURRENT_LIST_DIR}/src/pipico)
        if(MSVC)
            target_compile_options(fido_gesture_test PRIVATE /W4 /WX)
        else()
            target_compile_options(fido_gesture_test PRIVATE -Wall -Wextra -Werror)
        endif()
        foreach(scene IN ITEMS
            tap_29 tap_30 tap_500 tap_501 tap_dead_zone_800
            single_tap_window double_tap_299 double_tap_300 double_tap_301
            hold_1499 hold_1500 hold_2999 hold_3000 hold_9999 hold_10000
            overhold_rearm bounce_tap glitch_19 glitch_in_window_19 debounce_edge_20
            wrap_hold_1600 wrap_tap wrap_double_tap
            compound_tap_hold compound_tap_dead_zone compound_tap_too_short
            abort_mid_press abort_window abort_held
            stall_gap stall_gap_overhold start_pressed event_counts)
            add_test(NAME gesture_${scene} COMMAND fido_gesture_test ${scene})
        endforeach()

        # Pure keyboard arbiter (companion gating): accepts a gesture event
        # only when auth/UP/OTP are idle and the keyboard interface is
        # usable, holds one pending event for at most 100 ms and always
        # pairs an issued key-down with a release. One process per
        # scenario, so ctest -R arbiter selects them by name.
        add_executable(fido_kbd_arbiter_test
            ${CMAKE_CURRENT_LIST_DIR}/src/pipico/gesture.c
            ${CMAKE_CURRENT_LIST_DIR}/src/pipico/kbd_arbiter.c
            ${CMAKE_CURRENT_LIST_DIR}/tests/fido_kbd_arbiter_test.c
        )
        target_include_directories(fido_kbd_arbiter_test PRIVATE ${CMAKE_CURRENT_LIST_DIR}/src/pipico)
        if(MSVC)
            target_compile_options(fido_kbd_arbiter_test PRIVATE /W4 /WX)
        else()
            target_compile_options(fido_kbd_arbiter_test PRIVATE -Wall -Wextra -Werror)
        endif()
        foreach(scene IN ITEMS
            accept_all_clear drop_auth_busy drop_up_pending drop_auth_and_up
            drop_otp_typing drop_tx_busy drop_kb_disabled drop_unmounted drop_suspended
            stale_100 stale_101 stale_wrap
            interrupt_unmount interrupt_suspend interrupt_auth_busy interrupt_up_pending
            pending_blocks_on_otp queue_depth_one release_guaranteed release_after_wrap
            mapping started_during_busy_auth started_during_busy_otp)
            add_test(NAME arbiter_${scene} COMMAND fido_kbd_arbiter_test ${scene})
        endforeach()

        # Companion glue lifecycle (src/pipico/pipico.c pure core): the
        # per-tick pipeline sample -> gesture -> arbiter -> transmitter
        # with the auth-busy mapping is_busy() || exec_finished_cancelled.
        # Focus: cancellation-unwind suppression, normal rearming, the
        # F13..F16 mapping and the no-replay rule. One process per
        # scenario, so ctest -R glue selects them by name.
        add_executable(fido_pipico_glue_test
            ${CMAKE_CURRENT_LIST_DIR}/src/pipico/gesture.c
            ${CMAKE_CURRENT_LIST_DIR}/src/pipico/kbd_arbiter.c
            ${CMAKE_CURRENT_LIST_DIR}/src/pipico/pipico.c
            ${CMAKE_CURRENT_LIST_DIR}/tests/fido_pipico_glue_test.c
        )
        target_include_directories(fido_pipico_glue_test PRIVATE ${CMAKE_CURRENT_LIST_DIR}/src/pipico)
        if(MSVC)
            target_compile_options(fido_pipico_glue_test PRIVATE /W4 /WX)
        else()
            target_compile_options(fido_pipico_glue_test PRIVATE -Wall -Wextra -Werror)
        endif()
        foreach(scene IN ITEMS
            cancel_unwind_suppressed busy_kinds_suppress
            normal_completion_rearm cancel_clear_rearm mapping_f13_f16)
            add_test(NAME glue_${scene} COMMAND fido_pipico_glue_test ${scene})
        endforeach()
    else()
        target_link_libraries(
            pico_fido
            PRIVATE
                picokeys_sdk
                pico_stdlib
                pico_multicore
                hardware_flash
                hardware_sync
                hardware_adc
                pico_unique_id
                pico_aon_timer
                tinyusb_device
                tinyusb_board
        )
        pico_add_extra_outputs(${CMAKE_PROJECT_NAME})
    endif()
endif()
