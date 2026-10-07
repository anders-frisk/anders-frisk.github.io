# GPX to Polyline

```javascript
function gpxToPolyline(gpxString) {
    const xml = new DOMParser().parseFromString(gpxString, "application/xml");

    return Array.from(xml.querySelectorAll("trkpt"))
        .map(point => [
            point.getAttribute("lat"),
            point.getAttribute("lon")
        ]);
}
```