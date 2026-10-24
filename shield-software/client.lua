-- Shield Software client script: teleport, vehicle return and screen watch handlers.
-- Event names are kept in both the arcanium-web and ps-web namespaces for older panel builds.

local cachedFwType = nil
local cachedFwObj = nil

local function GetFramework()
    if cachedFwType and cachedFwObj then return cachedFwType, cachedFwObj end
    if QBCore ~= nil then cachedFwType, cachedFwObj = "qb", QBCore return cachedFwType, cachedFwObj end
    if ESX ~= nil then cachedFwType, cachedFwObj = "esx", ESX return cachedFwType, cachedFwObj end
    if GetResourceState('qb-core') == 'started' then
        local success, obj = pcall(function() return exports['qb-core']:GetCoreObject() end)
        if success and obj then cachedFwType, cachedFwObj = "qb", obj return cachedFwType, cachedFwObj end
    end
    if GetResourceState('es_extended') == 'started' then
        local success, obj = pcall(function() return exports['es_extended']:getSharedObject() end)
        if success and obj then cachedFwType, cachedFwObj = "esx", obj return cachedFwType, cachedFwObj end
    end
    return nil, nil
end

local function SendNotification(msg, notifyType)
    local fwType, fwObj = GetFramework()
    if fwType == "qb" and fwObj and fwObj.Functions then
        fwObj.Functions.Notify(msg, notifyType or "primary", 5000)
    elseif fwType == "esx" and fwObj and fwObj.ShowNotification then
        fwObj.ShowNotification(msg)
    else
        TriggerEvent("chat:addMessage", {
            color = notifyType == "error" and {255, 80, 80} or {0, 149, 255},
            multiline = true,
            args = {"[Arcanium-Web]", msg}
        })
    end
end

-- Teleport handler
local function HandleTeleport(x, y, z)
    local numX, numY, numZ = tonumber(x), tonumber(y), tonumber(z)
    if not numX or not numY or not numZ then return end
    
    local ped = PlayerPedId()
    if not DoesEntityExist(ped) or IsEntityDead(ped) then return end

    local targetEntity = ped
    if IsPedInAnyVehicle(ped, false) then
        targetEntity = GetVehiclePedIsIn(ped, false)
    end
    
    -- Freeze entity to prevent glitching / falling through map
    FreezeEntityPosition(targetEntity, true)
    
    -- Collision preloading
    RequestCollisionAtCoord(numX, numY, numZ)
    
    -- Safe server-side verified entity positioning
    SetEntityCoords(targetEntity, numX + 0.0, numY + 0.0, numZ + 0.0, false, false, false, true)
    
    Citizen.Wait(500)
    FreezeEntityPosition(targetEntity, false)
    
    local msg = ("Işınlandın → X: %.2f | Y: %.2f | Z: %.2f"):format(numX, numY, numZ)
    SendNotification(msg, "primary")
end

RegisterNetEvent("arcanium-web:client:teleport", HandleTeleport)
RegisterNetEvent("ps-web:client:teleport", HandleTeleport)

-- Vehicle return handler (vreturn)
local function HandleVReturn(plate)
    if not plate or plate == "" then return end

    local targetPlateClean = plate:gsub("%s+", ""):upper()
    local ped     = PlayerPedId()
    local pCoords = GetEntityCoords(ped)
    local found   = false

    -- Önce dünyada o plakayla bir araç var mı bak
    local vehicles = GetGamePool('CVehicle')
    for _, veh in ipairs(vehicles) do
        local vPlate = GetVehicleNumberPlateText(veh)
        if vPlate and vPlate:gsub("%s+", ""):upper() == targetPlateClean then
            -- Aracı oyuncunun 5 metre önüne taşı
            local fwd    = GetEntityForwardVector(ped)
            local spawnX = pCoords.x + fwd.x * 5.0
            local spawnY = pCoords.y + fwd.y * 5.0
            local spawnZ = pCoords.z
            SetEntityCoords(veh, spawnX, spawnY, spawnZ, false, false, false, false)
            SetEntityHeading(veh, GetEntityHeading(ped))
            SetVehicleEngineOn(veh, true, true, false)
            found = true
            break
        end
    end

    -- Bildirimi gönder
    if found then
        local msg = ("🚗 Araç çekildi → Plaka: %s"):format(plate)
        SendNotification(msg, "primary")
    end
end

RegisterNetEvent("arcanium-web:client:vreturn", HandleVReturn)
RegisterNetEvent("ps-web:client:vreturn", HandleVReturn)

local isScreenWatching = false
local inFlight = 0
local maxInFlight = 2

local function StopScreenWatch()
    isScreenWatching = false
    inFlight = 0
end

local function StartScreenWatch(data)
    if not data or not data.uploadUrl then return end
    if GetResourceState('screenshot-basic') ~= 'started' then return end

    isScreenWatching = true
    inFlight = 0
    local uploadUrl = data.uploadUrl
    local interval = tonumber(data.interval) or 16
    if interval < 15 then interval = 15 end
    local quality = tonumber(data.quality) or 0.60
    if quality > 0.85 then quality = 0.85 end

    Citizen.CreateThread(function()
        while isScreenWatching do
            if inFlight < maxInFlight then
                inFlight = inFlight + 1
                local completed = false

                Citizen.SetTimeout(2500, function()
                    if not completed then
                        completed = true
                        inFlight = math.max(0, inFlight - 1)
                    end
                end)

                exports['screenshot-basic']:requestScreenshotUpload(uploadUrl, 'file', {
                    encoding = 'jpg',
                    quality = quality
                }, function(res)
                    if not completed then
                        completed = true
                        inFlight = math.max(0, inFlight - 1)
                    end
                end)
            end
            Citizen.Wait(interval)
        end
        inFlight = 0
    end)
end

RegisterNetEvent("shield:client:startScreenWatch", StartScreenWatch)
RegisterNetEvent("shield:client:stopScreenWatch", StopScreenWatch)
RegisterNetEvent("arcanium-web:client:startScreenWatch", StartScreenWatch)
RegisterNetEvent("arcanium-web:client:stopScreenWatch", StopScreenWatch)
