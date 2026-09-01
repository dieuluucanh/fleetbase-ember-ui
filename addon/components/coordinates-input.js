import Component from '@glimmer/component';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { isBlank } from '@ember/utils';
import { isArray } from '@ember/array';
import { later } from '@ember/runloop';
import { debug } from '@ember/debug';
import { task } from 'ember-concurrency';
import getWithDefault from '@fleetbase/ember-core/utils/get-with-default';

const DEFAULT_LATITUDE = 1.3521;
const DEFAULT_LONGITUDE = 103.8198;

// OpenStreetMap
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OSM_MAX_ZOOM = 19;

export default class CoordinatesInputComponent extends Component {
    @service fetch;
    @service currentUser;

    @tracked zoom;
    @tracked zoomControl;
    @tracked leafletMap;
    @tracked latitude;
    @tracked longitude;
    @tracked mapLat;
    @tracked mapLng;
    @tracked lookupQuery;
    @tracked isLoading = false;
    @tracked isReady = false;
    @tracked isInitialMoveEnded = false;

    // Leaflet + OpenStreetMap
    @tracked tileSourceUrl = OSM_TILE_URL;
    @tracked tileAttribution = OSM_ATTRIBUTION;
    @tracked tileMaxZoom = OSM_MAX_ZOOM;

    @tracked mapTheme = 'osm';
    @tracked disabled = false;

    /**
     * Constructor for CoordinatesInputComponent.
     */
    constructor(
        owner,
        {
            onInit,
            value,
            darkMode = false,
            zoom = 9,
            zoomControl = false,
            disabled = false,
        }
    ) {
        super(...arguments);

        this.setInitialMapCoordinates();
        this.setInitialValueFromPoint(value);

        this.changeTileSource(darkMode ? 'dark' : 'osm');

        this.zoom = zoom;
        this.zoomControl = zoomControl;
        this.disabled = disabled;

        if (typeof onInit === 'function') {
            onInit(this);
        }
    }

    /**
     * Change Leaflet tile source.
     *
     * "osm", "light", "dark", "dark_all"
     *
     */
    changeTileSource(sourceUrl = 'osm', attribution = null) {
        if (typeof sourceUrl === 'string' && sourceUrl.startsWith('https://')) {
            this.mapTheme = 'custom';
            this.tileSourceUrl = sourceUrl;
            this.tileAttribution = attribution ?? '';
            return;
        }

        this.mapTheme = sourceUrl === 'dark' || sourceUrl === 'dark_all' ? 'dark' : 'osm';

        this.tileSourceUrl = OSM_TILE_URL;
        this.tileAttribution = OSM_ATTRIBUTION;
        this.tileMaxZoom = OSM_MAX_ZOOM;
    }

    /**
     * Checks if the provided object is a geographical point.
     */
    isPoint(point) {
        return (
            typeof point === 'object' &&
            !isBlank(point.type) &&
            point.type === 'Point' &&
            isArray(point.coordinates)
        );
    }

    /**
     * Sets initial coordinates from GeoJSON Point.
     */
    setInitialValueFromPoint(point) {
        if (this.isPoint(point)) {
            const [longitude, latitude] = point.coordinates;

            if (longitude === 0 && latitude === 0) {
                return;
            }

            this.updateCoordinates(latitude, longitude, {
                fireCallback: false,
            });
        }
    }

    /**
     * Sets initial map coordinates using current user's location.
     */
    setInitialMapCoordinates() {
        const whois = this.currentUser.getOption('whois', {});

        this.mapLat = getWithDefault(
            whois,
            'latitude',
            DEFAULT_LATITUDE
        );

        this.mapLng = getWithDefault(
            whois,
            'longitude',
            DEFAULT_LONGITUDE
        );
    }

    /**
     * Updates map coordinates.
     */
    updateCoordinates(lat, lng, options = {}) {
        if (this.isPoint(lat)) {
            const [longitude, latitude] = lat.coordinates;

            return this.updateCoordinates(
                latitude,
                longitude,
                options
            );
        }

        const { onChange } = this.args;

        const fireCallback = getWithDefault(
            options,
            'fireCallback',
            true
        );

        const updateMap = getWithDefault(
            options,
            'updateMap',
            true
        );

        this.latitude = lat;
        this.longitude = lng;

        if (updateMap === true) {
            this.mapLat = lat;
            this.mapLng = lng;
        }

        if (
            fireCallback === true &&
            typeof onChange === 'function'
        ) {
            onChange({
                latitude: lat,
                longitude: lng,
            });
        }
    }

    /**
     * Leaflet map loaded.
     */
    @action
    onMapLoaded({ target }) {
        this.leafletMap = target;

        later(
            this,
            () => {
                this.isReady = true;
            },
            300
        );
    }

    /**
     * Zoom in.
     */
    @action
    onZoomIn() {
        if (this.leafletMap) {
            this.leafletMap.zoomIn();
        }
    }

    /**
     * Zoom out.
     */
    @action
    onZoomOut() {
        if (this.leafletMap) {
            this.leafletMap.zoomOut();
        }
    }

    /**
     * Close/reset map center.
     */
    @action
    onClose() {
        this.mapLat = this.latitude;
        this.mapLng = this.longitude;
    }

    /**
     * Set coordinates from current Leaflet map center.
     */
    @action
    setCoordinatesFromMap(event) {
        const { onUpdatedFromMap } = this.args;
        const { target } = event;

        const center = target.getCenter();

        const geographicalCenter =
            typeof center.wrap === 'function'
                ? center.wrap()
                : center;

        const { lat, lng } = geographicalCenter;

        this.updateCoordinates(lat, lng, {
            updateMap: false,
        });

        if (typeof onUpdatedFromMap === 'function') {
            onUpdatedFromMap({
                latitude: lat,
                longitude: lng,
            });
        }
    }

    /**
     * Address/place lookup.
     *
     * Hiện tại vẫn sử dụng Fleetbase geocoder API.
     * Map tile thì đã chuyển hoàn toàn sang OSM.
     */
    @task
    *reverseLookup() {
        if (isBlank(this.lookupQuery)) {
            return;
        }

        try {
            const place = yield this.fetch.get(
                'geocoder/query-oss',
                {
                    query: this.lookupQuery,
                    single: true,
                }
            );

            if (place) {
                const [longitude, latitude] =
                    place.location.coordinates;

                this.updateCoordinates(
                    latitude,
                    longitude
                );

                if (
                    typeof this.args.onGeocode ===
                    'function'
                ) {
                    this.args.onGeocode(place);
                }
            }

            return place;
        } catch (error) {
            debug(
                'Coordinates input reverse lookup query failed:',
                error
            );

            if (
                typeof this.args.onGeocodeError ===
                'function'
            ) {
                this.args.onGeocodeError(error);
            }
        }
    }
}