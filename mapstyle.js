/* Sade, düz harita görünümü (Google Haritalar tarzı).
 * OpenFreeMap "liberty" stilini alıp renklerini ve detayını sadeleştirir.
 */
(function (root) {
  'use strict';

  const C = {
    land: '#f5f3f0',
    water: '#aad3f5',
    waterText: '#4a7fb5',
    park: '#cdeac9',
    green: '#d9eed5',
    sand: '#f5eed9',
    hospital: '#fbe4e4',
    school: '#f1eee7',
    airport: '#ebe9f0',
    runway: '#dcd9e3',
    building: '#e9e6e1',
    buildingLine: '#dedad4',
    road: '#ffffff',
    roadCase: '#dad7d1',
    tunnel: '#f0eeea',
    highway: '#fcd57f',
    highwayCase: '#e8b54e',
    path: '#c9c4ba',
    rail: '#d3d0cb',
    boundary: '#b9b3c9',
    text: '#5f6368',
    textDark: '#3c4043',
    halo: '#ffffff',
  };

  const HIDE = new Set([
    'natural_earth', 'park_outline', 'landuse_residential', 'building-3d',
    'road_one_way_arrow', 'road_one_way_arrow_opposite',
    'poi_r20', 'poi_r7', 'poi_transit',
    'highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us',
    'tunnel_major_rail_hatching', 'tunnel_transit_rail_hatching',
    'road_major_rail_hatching', 'road_transit_rail_hatching',
    'bridge_major_rail_hatching', 'bridge_transit_rail_hatching',
  ]);

  const FILL = {
    background: C.land,
    park: C.park,
    landcover_wood: C.park,
    landcover_grass: C.green,
    landcover_wetland: C.green,
    landcover_ice: '#ffffff',
    landcover_sand: C.sand,
    landuse_pitch: C.green,
    landuse_track: C.green,
    landuse_cemetery: C.green,
    landuse_hospital: C.hospital,
    landuse_school: C.school,
    water: C.water,
    aeroway_fill: C.airport,
    road_area_pattern: C.tunnel,
    building: C.building,
  };

  function set(layer, group, prop, value) {
    layer[group] = layer[group] || {};
    layer[group][prop] = value;
  }

  function lineColor(id) {
    if (/rail/.test(id)) return C.rail;
    if (/path_pedestrian/.test(id)) return /casing/.test(id) ? C.roadCase : C.path;
    if (/motorway/.test(id)) return /casing/.test(id) ? C.highwayCase : C.highway;
    if (/casing/.test(id)) return C.roadCase;
    if (/^tunnel_/.test(id)) return C.tunnel;
    return C.road;
  }

  function restyle(style) {
    for (const l of style.layers) {
      const id = l.id;
      if (HIDE.has(id)) { set(l, 'layout', 'visibility', 'none'); continue; }

      if (l.type === 'background') { set(l, 'paint', 'background-color', C.land); continue; }

      if (l.type === 'fill' && FILL[id]) {
        if (l.paint) delete l.paint['fill-pattern'];
        set(l, 'paint', 'fill-color', FILL[id]);
        set(l, 'paint', 'fill-opacity', 1);
        if (id === 'building') set(l, 'paint', 'fill-outline-color', C.buildingLine);
        else if (l.paint) delete l.paint['fill-outline-color'];
        continue;
      }

      if (l.type === 'line') {
        if (l['source-layer'] === 'waterway') { set(l, 'paint', 'line-color', C.water); continue; }
        if (l['source-layer'] === 'aeroway') { set(l, 'paint', 'line-color', C.runway); continue; }
        if (l['source-layer'] === 'boundary') { set(l, 'paint', 'line-color', C.boundary); continue; }
        if (l['source-layer'] === 'transportation') {
          if (l.paint) delete l.paint['line-pattern'];
          set(l, 'paint', 'line-color', lineColor(id));
          continue;
        }
      }

      if (l.type === 'symbol' && l.layout && l.layout['text-field'] !== undefined) {
        const water = /^water/.test(id);
        const place = /^label_/.test(id);
        set(l, 'paint', 'text-color', water ? C.waterText : place ? C.textDark : C.text);
        set(l, 'paint', 'text-halo-color', C.halo);
        set(l, 'paint', 'text-halo-width', 1.5);
        set(l, 'paint', 'text-halo-blur', 0);
      }
    }
    return style;
  }

  root.izimRestyle = restyle;
  if (typeof module !== 'undefined') module.exports = restyle;
})(typeof window !== 'undefined' ? window : globalThis);
