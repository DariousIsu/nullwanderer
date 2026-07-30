/**
 * lib/us_capitals_cities.js — the STATE-LADDER head: each state's capital + largest cities.
 *
 * PROVENANCE (birth context): authored from Claude's general knowledge (2026-07-29, Lucas's slice-B
 * leash design — "every state should be mapped from the state government down including capitals and
 * large cities"), NOT from a Census extract like the other gazetteers. Ordering within `large` is
 * approximate 2020-census population (descending) and is a PRIORITY hint, not a fact the program
 * asserts — the research pass corroborates everything it reports. Names are matched against the
 * bundled Census place gazetteer at load (lib/beats.js matchPlace), so a name that doesn't resolve
 * to a real incorporated place simply drops out (e.g. Honolulu — Hawaii has no incorporated places;
 * governance is county-level and the county tier covers it).
 *
 * Shape: { <USPS>: { capital, large: [city, ...] } }. The ladder head list = capital first, then
 * `large` in order, deduped — the capital leads because it is the seat of the state government the
 * ladder descends from.
 */
'use strict';

module.exports = {
  AL: { capital: 'Montgomery', large: ['Huntsville', 'Birmingham', 'Mobile', 'Tuscaloosa'] },
  AK: { capital: 'Juneau', large: ['Anchorage', 'Fairbanks'] },
  AZ: { capital: 'Phoenix', large: ['Tucson', 'Mesa', 'Chandler', 'Scottsdale', 'Glendale'] },
  AR: { capital: 'Little Rock', large: ['Fort Smith', 'Fayetteville', 'Springdale', 'Jonesboro'] },
  CA: { capital: 'Sacramento', large: ['Los Angeles', 'San Diego', 'San Jose', 'San Francisco', 'Fresno', 'Long Beach', 'Oakland'] },
  CO: { capital: 'Denver', large: ['Colorado Springs', 'Aurora', 'Fort Collins', 'Lakewood'] },
  CT: { capital: 'Hartford', large: ['Bridgeport', 'New Haven', 'Stamford', 'Waterbury'] },
  DE: { capital: 'Dover', large: ['Wilmington', 'Newark'] },
  FL: { capital: 'Tallahassee', large: ['Jacksonville', 'Miami', 'Tampa', 'Orlando', 'St. Petersburg', 'Hialeah'] },
  GA: { capital: 'Atlanta', large: ['Augusta', 'Columbus', 'Macon', 'Savannah', 'Athens'] },
  HI: { capital: 'Honolulu', large: [] },
  ID: { capital: 'Boise', large: ['Meridian', 'Nampa', 'Idaho Falls'] },
  IL: { capital: 'Springfield', large: ['Chicago', 'Aurora', 'Joliet', 'Naperville', 'Rockford', 'Elgin', 'Peoria'] },
  IN: { capital: 'Indianapolis', large: ['Fort Wayne', 'Evansville', 'South Bend', 'Carmel'] },
  IA: { capital: 'Des Moines', large: ['Cedar Rapids', 'Davenport', 'Sioux City'] },
  KS: { capital: 'Topeka', large: ['Wichita', 'Overland Park', 'Kansas City', 'Olathe'] },
  KY: { capital: 'Frankfort', large: ['Louisville', 'Lexington', 'Bowling Green', 'Owensboro'] },
  LA: { capital: 'Baton Rouge', large: ['New Orleans', 'Shreveport', 'Lafayette', 'Lake Charles'] },
  ME: { capital: 'Augusta', large: ['Portland', 'Lewiston', 'Bangor'] },
  MD: { capital: 'Annapolis', large: ['Baltimore', 'Frederick', 'Rockville', 'Gaithersburg'] },
  MA: { capital: 'Boston', large: ['Worcester', 'Springfield', 'Cambridge', 'Lowell'] },
  MI: { capital: 'Lansing', large: ['Detroit', 'Grand Rapids', 'Warren', 'Sterling Heights', 'Ann Arbor'] },
  MN: { capital: 'St. Paul', large: ['Minneapolis', 'Rochester', 'Duluth', 'Bloomington'] },
  MS: { capital: 'Jackson', large: ['Gulfport', 'Southaven', 'Hattiesburg', 'Biloxi'] },
  MO: { capital: 'Jefferson City', large: ['Kansas City', 'St. Louis', 'Springfield', 'Columbia', 'Independence'] },
  MT: { capital: 'Helena', large: ['Billings', 'Missoula', 'Great Falls', 'Bozeman'] },
  NE: { capital: 'Lincoln', large: ['Omaha', 'Bellevue', 'Grand Island'] },
  NV: { capital: 'Carson City', large: ['Las Vegas', 'Henderson', 'Reno', 'North Las Vegas', 'Sparks'] },
  NH: { capital: 'Concord', large: ['Manchester', 'Nashua'] },
  NJ: { capital: 'Trenton', large: ['Newark', 'Jersey City', 'Paterson', 'Elizabeth'] },
  NM: { capital: 'Santa Fe', large: ['Albuquerque', 'Las Cruces', 'Rio Rancho'] },
  NY: { capital: 'Albany', large: ['New York', 'Buffalo', 'Rochester', 'Yonkers', 'Syracuse'] },
  NC: { capital: 'Raleigh', large: ['Charlotte', 'Greensboro', 'Durham', 'Winston-Salem', 'Fayetteville'] },
  ND: { capital: 'Bismarck', large: ['Fargo', 'Grand Forks', 'Minot'] },
  OH: { capital: 'Columbus', large: ['Cleveland', 'Cincinnati', 'Toledo', 'Akron', 'Dayton'] },
  OK: { capital: 'Oklahoma City', large: ['Tulsa', 'Norman', 'Broken Arrow'] },
  OR: { capital: 'Salem', large: ['Portland', 'Eugene', 'Gresham', 'Hillsboro'] },
  PA: { capital: 'Harrisburg', large: ['Philadelphia', 'Pittsburgh', 'Allentown', 'Erie', 'Reading'] },
  RI: { capital: 'Providence', large: ['Cranston', 'Warwick', 'Pawtucket'] },
  SC: { capital: 'Columbia', large: ['Charleston', 'North Charleston', 'Mount Pleasant', 'Greenville'] },
  SD: { capital: 'Pierre', large: ['Sioux Falls', 'Rapid City'] },
  TN: { capital: 'Nashville', large: ['Memphis', 'Knoxville', 'Chattanooga', 'Clarksville'] },
  TX: { capital: 'Austin', large: ['Houston', 'San Antonio', 'Dallas', 'Fort Worth', 'El Paso', 'Arlington', 'Corpus Christi'] },
  UT: { capital: 'Salt Lake City', large: ['West Valley City', 'West Jordan', 'Provo'] },
  VT: { capital: 'Montpelier', large: ['Burlington', 'South Burlington', 'Rutland'] },
  VA: { capital: 'Richmond', large: ['Virginia Beach', 'Chesapeake', 'Norfolk', 'Newport News', 'Alexandria'] },
  WA: { capital: 'Olympia', large: ['Seattle', 'Spokane', 'Tacoma', 'Vancouver', 'Bellevue'] },
  WV: { capital: 'Charleston', large: ['Huntington', 'Morgantown'] },
  WI: { capital: 'Madison', large: ['Milwaukee', 'Green Bay', 'Kenosha', 'Racine'] },
  WY: { capital: 'Cheyenne', large: ['Casper', 'Laramie'] },
};
