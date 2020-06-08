'use strict';

import rp from 'request-promise-native';
import cheerio from 'cheerio';
import _ from 'lodash';

const MAP_DATA_URL = 'http://www.scottishairquality.scot/js/data/map-data';
const MEASUREMENTS_URL = 'http://www.scottishairquality.scot/data/data-selector';

export const name = 'scotland';

// The forms we'll be submitting are strangely picky about POST data, so we convert everything to querystring and use GET
const objectToQueryString = obj => {
  const results = [];
  _.forOwn(obj, (value, key) => {
    if (Array.isArray(value)) {
      _.forOwn(value, value => {
        results.push(`${key}[]=${value}`);
      });
    } else {
      results.push(`${key}=${value}`);
    }
  });
  return results.join('&');
};

// This adapter does some odd things, becuase scottishairquality.scot is tricky:
// 1. There is no API, and the FTP server is a myth (https://github.com/openaq/openaq-fetch/issues/666?fbclid=IwAR0eC-kiTdhRP6yi43eV6hniA9ZuiDjZ4barBSLC40h9gYDK4YxlConA1t0#issuecomment-632684496)
// 2. If we want hourly measurements, we can't get them from the "Latest & Forecasts" pages (e.g http://www.scottishairquality.scot/latest/site-info?site_id=SL05)
// 3. Instead we must fetch them individually for each location from "Measurement And Annual Statistics", which involves building a query stored on the backend via *multiple* form submissions per location

// Fortunately, the website has an interactive map of locations.
// We can access the json data powering this map to get a Name, ID and lat-long for each location
const fetchLocations = async () => {
  const locations = await rp(MAP_DATA_URL);
  // Array of response objects each look like this:
  //   "site_id": "ABD1",
  //   "site_name": "Aberdeen Anderson Dr",
  //   "latitude": "57.128567",
  //   "longitude": "-2.125447",
  //   "overall_index": "1",
  //   "environment_id": "5",
  //   "pollutant_id": "NO2,PM10",
  //   "last_updated": "06/06/2020 15:00"
  const mapped = JSON.parse(locations).map(({site_id: id, site_name: name, latitude: lat, longitude: long}) => ({ id, name, lat, long }));
  return mapped;
};

// scottishairquality calls its "PM10 particulate matter (Hourly measured)" measure 'GE10' so we need a mapping...
const PARAMETER_MAPPING = {
  pm25: 'PM25',
  pm10: 'GE10',
  no2: 'NO2',
  so2: 'SO2',
  o3: 'O3',
  co: 'CO',
  bc: 'BC'
};

// names of the form elements we'll be using
const PARAMETER_GROUP_INPUT_NAME = 'f_group_id';
const QUERY_ID_INPUT_NAME = 'f_query_id';
const PARAMETERS_INPUT_NAME = 'f_parameter_id';
const REGIONS_INPUT_NAME = 'f_sub_region_id';
const STAT_TYPE_INPUT_NAME = 'f_statistic_type_id';
const DATE_PRESET_INPUT_NAME = 'f_preset_date';
const SITE_ID_INPUT_NAME = 'f_site_id';
const EMAIL_INPUT_NAME = 'f_email';

// values of the form elements we'll be using
// TODO: find these values in the form body so this keeps working if they change
const PARAMETER_GROUP_VALUE_AUTOMATIC_MONITORING = '4';
const PARAMETERS_VALUE_ALL = Object.values(PARAMETER_MAPPING);
const REGIONS_INPUT_VALUE_ALL = ['9999'];
const STAT_TYPE_MEASURED_DATA = '9999';
const DATE_PRESET_TODAY_VALUE = '1';

const getMeasurementsForLocation = async (location) => {
  const {id, name} = location;
  // Stage 0 - create our query, set the parameter group to automatic monitoring
  // let stage0 = await rp(`${MEASUREMENTS_URL}?${PARAMETER_GROUP_INPUT_NAME}=${PARAMETER_GROUP_VALUE_AUTOMATIC_MONITORING}&go=Step 1&action=step1`);
  let stage0 = await rp(`${MEASUREMENTS_URL}?${objectToQueryString({
    [PARAMETER_GROUP_INPUT_NAME]: PARAMETER_GROUP_VALUE_AUTOMATIC_MONITORING,
    go: 'Step 1',
    action: 'step1'
  })}`);
  // Store the query id for subsequent queries
  let $ = cheerio.load(stage0);
  const queryId = parseInt($(`[name='${QUERY_ID_INPUT_NAME}']`).val());

  // Note: we also need to specify "automatic monitoring" for all subsequent requests, as there are 2 separate sets of forms at this URL...
  // hence: `[PARAMETER_GROUP_INPUT_NAME]: PARAMETER_GROUP_VALUE_AUTOMATIC_MONITORING,` in all the requests below

  // Stage 1 - set our desired parameters
  let stage1 = await rp(`${MEASUREMENTS_URL}?${objectToQueryString({
    [PARAMETER_GROUP_INPUT_NAME]: PARAMETER_GROUP_VALUE_AUTOMATIC_MONITORING,
    [QUERY_ID_INPUT_NAME]: queryId,
    [PARAMETERS_INPUT_NAME]: PARAMETERS_VALUE_ALL,
    go: 'Step 2',
    action: 'step2'
  })}`);

  // Stage 2 - set our region to all, stat type to "measured data"
  let stage2 = await rp(`${MEASUREMENTS_URL}?${objectToQueryString({
    [PARAMETER_GROUP_INPUT_NAME]: PARAMETER_GROUP_VALUE_AUTOMATIC_MONITORING,
    [QUERY_ID_INPUT_NAME]: queryId,
    [REGIONS_INPUT_NAME]: REGIONS_INPUT_VALUE_ALL,
    [STAT_TYPE_INPUT_NAME]: STAT_TYPE_MEASURED_DATA,
    go: 'Step 3',
    action: 'step3'
  })}`);

  // Stage 3 - set our date preset to "Today"
  let stage3 = await rp(`${MEASUREMENTS_URL}?${objectToQueryString({
    [PARAMETER_GROUP_INPUT_NAME]: PARAMETER_GROUP_VALUE_AUTOMATIC_MONITORING,
    [QUERY_ID_INPUT_NAME]: queryId,
    [DATE_PRESET_INPUT_NAME]: DATE_PRESET_TODAY_VALUE,
    go: 'Step 4',
    action: 'step4'
  })}`);

  // Stage 4 - set our desired monitoring site to the location's ID
  let stage4 = await rp(`${MEASUREMENTS_URL}?${objectToQueryString({
    [PARAMETER_GROUP_INPUT_NAME]: PARAMETER_GROUP_VALUE_AUTOMATIC_MONITORING,
    [QUERY_ID_INPUT_NAME]: queryId,
    [SITE_ID_INPUT_NAME]: [id],
    go: 'Step 5',
    action: 'step5'
  })}`);

  // Stage 5 - submit a blank email adress and get our measurements
  let stage5 = await rp(`${MEASUREMENTS_URL}?${objectToQueryString({
    [PARAMETER_GROUP_INPUT_NAME]: PARAMETER_GROUP_VALUE_AUTOMATIC_MONITORING,
    [QUERY_ID_INPUT_NAME]: queryId,
    [EMAIL_INPUT_NAME]: '',
    go: 'Step 6',
    action: 'step6'
  })}`);

  // Finally we have our data for this location!
  $ = cheerio.load(stage5);

  const rows = $('table tr');
  const groupsHeader = $(rows[0]);
  const columnsHeader = $(rows[1]);
  // This table layout is a bit strange to parse:
  // 1. There is no thead/tbody, it's just a whole bunch of rows
  // 2. The number/order of columns will change depending on which parameters the location supports
  // 3. Each row can contain measurements from multiple parameters *and* locations

  // Note: ONLY CHAOS FOLLOWS

  // // We'll eventually go through the table cell-by-cell to build measurements.
  // // To do this, we want a mapping of column-index to location + parameter
  // const tableColumns = [];

  // // First, use the row 0 to find column ranges for each location
  // const columnGroups = [];
  // groupsHeader.children('td').each((cell, index) => {
  //   const name = $(cell).text();
  //   const numColumns = $(cell).attr('colspan');
  //   // Measurement Period columns
  //   if (name === 'Measurement Period') {
  //     columnGroups[index] = {
  //       name,
  //       first: 0,
  //       last: numColumns - 1
  //     };
  //   } else {
  //     const first = columnGroups[columnGroups.length - 1].last + 1;
  //     columnGroups[index] = {
  //       name,
  //       first,
  //       last: first + numColumns - 1
  //     };
  //   }
  // });

  // // Next, work our which parameters are shown for each location:
  // const columnHeaderCells = columnsHeader.children('td');
  // columnHeaderCells.each((cell, index) => {
  //   const text = $(cell).text();
  //   // find our matching location by range
  //   const columnGroup = columnGroups.find(({first, last}) => index >= first && index <= last);
  //   if (columnGroup.name === 'Measurement Period') {
  //     tableColumns.push({
  //       locationName: null,
  //       isDate: index === 0,
  //       isTime: index === 1
  //     });
  //   } else {
  //     const locationName = columnGroup.text;
  //     const isParameterColumn = PARAMETERS_VALUE_ALL.includes(text);
  //     if (isParameterColumn) {
  //       const parameterName = Object.keys(PARAMETER_MAPPING).map(key => PARAMETER_MAPPING[key] === text);
  //       // Find the matching Measurement parameter
  //       tableColumns.push({
  //         locationName,
  //         parameterName
  //       });
  //     } else if (text.toLowerCase().includes('units')) {
  //       // All other columns in this location (with both a lower index and no assigned unit) are assigned this unit
  //       tableColumns.filter((column, otherIndex) => column.locationName === locationName && otherIndex < index && !column.unit).forEach((column) => column.unit = )
  //     }
  //   }
  // });

  // let measurements = rows.map((index, rowEl) => {
  //   // skip headers
  //   if (index < 2) {
  //     return;
  //   }

  //   const date = $(rowEl).children('td')[0].text();
  //   const time = $(rowEl).children('td')[1].text();
  // });
  // console.log('rows', rows);

  // Mock data!
  let measurement = {
    location: name,
    parameter: 'pm25',
    unit: 'ppm',
    averagingPeriod: {
      value: 1,
      unit: 'hours'
    },
    coordinates: {
      latitude: -3,
      longitude: 5
    },
    value: 5,
    date: {
      utc: '2020-06-06T09:43:35.900Z',
      local: '2020-06-06T09:43:35+01:00'
    },
    city: '???',
    country: 'gb'
  };

  return {
    ...location,
    measurements: [measurement]
  };
};

const doEverythingButLikeAsynchronously = async (source) => {
  const { url, name } = source;
  const baseMeasurement = {
    attribution: [ { name, url } ],
    sourceName: name,
    sourceType: 'government',
    mobile: false
  };
  const locations = await fetchLocations();
  let testLocations = locations.slice(0, 1);
  let locationsWithMeasurements = await Promise.all(
    testLocations.map(async location => getMeasurementsForLocation(location))
  );
  // Flatten locations.measurements down to measurements, spread onto the baseMeasurement like some delicious Scottish jam
  const measurements = locationsWithMeasurements.reduce((measurements, location) => measurements.concat(location.measurements), []).map(measurement => ({...measurement, ...baseMeasurement}));
  return measurements;
};

export function fetchData (source, callback) {
  doEverythingButLikeAsynchronously(source)
    .then(measurements => {
      console.log('measurements', measurements);
      let data = {
        name,
        measurements
      };
      callback(undefined, data);
    });
}
