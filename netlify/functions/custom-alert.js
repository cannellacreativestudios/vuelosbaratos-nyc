const https = require('https');

exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        // Parse request body
        const data = JSON.parse(event.body);
        
        // Validate required fields
        if (!data.email || !data.destination || !data.departure_airport || !data.target_price) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Missing required fields' })
            };
        }

        // Klaviyo API configuration
        const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
        const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;

        if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
            console.error('Missing Klaviyo configuration');
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'Service configuration error' })
            };
        }

        // Prepare Klaviyo profile data
        const profileData = {
            data: {
                type: 'profile',
                attributes: {
                    email: data.email,
                    properties: {
                        // Custom search preferences
                        destination: data.destination,
                        departure_airport: data.departure_airport,
                        timeframe: data.timeframe,
                        travel_class: data.travel_class,
                        target_price: parseFloat(data.target_price),
                        
                        // Alert settings
                        alert_type: data.alert_type || 'custom_search',
                        signup_source: data.signup_source || 'website',
                        language: data.language || 'es',
                        location: data.location || 'NYC',
                        
                        // Metadata
                        signup_date: new Date().toISOString(),
                        last_updated: new Date().toISOString(),
                        
                        // Segmentation tags
                        has_custom_alert: true,
                        preferred_departure: data.departure_airport,
                        price_range: getPriceRange(data.target_price),
                        destination_region: getDestinationRegion(data.destination)
                    }
                }
            }
        };

        // Create or update profile in Klaviyo
        const profileResponse = await makeKlaviyoRequest(
            'POST',
            '/api/profiles/',
            profileData,
            KLAVIYO_API_KEY
        );

        if (!profileResponse.success) {
            throw new Error(`Klaviyo profile error: ${profileResponse.error}`);
        }

        // Add profile to list
        const listData = {
            data: [
                {
                    type: 'profile',
                    id: profileResponse.data.data.id
                }
            ]
        };

        const listResponse = await makeKlaviyoRequest(
            'POST',
            `/api/lists/${KLAVIYO_LIST_ID}/relationships/profiles/`,
            listData,
            KLAVIYO_API_KEY
        );

        if (!listResponse.success) {
            console.warn(`Warning: Could not add to list: ${listResponse.error}`);
        }

        // Track custom event
        const eventData = {
            data: {
                type: 'event',
                attributes: {
                    profile: {
                        email: data.email
                    },
                    metric: {
                        name: 'Custom Flight Alert Created'
                    },
                    properties: {
                        destination: data.destination,
                        departure_airport: data.departure_airport,
                        target_price: parseFloat(data.target_price),
                        travel_class: data.travel_class,
                        timeframe: data.timeframe
                    },
                    time: new Date().toISOString()
                }
            }
        };

        await makeKlaviyoRequest(
            'POST',
            '/api/events/',
            eventData,
            KLAVIYO_API_KEY
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: 'Custom alert created successfully',
                profile_id: profileResponse.data.data.id
            })
        };

    } catch (error) {
        console.error('Custom alert error:', error);
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Failed to create custom alert',
                message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
            })
        };
    }
};

// Helper function to make Klaviyo API requests
async function makeKlaviyoRequest(method, endpoint, data, apiKey) {
    return new Promise((resolve) => {
        const postData = JSON.stringify(data);
        
        const options = {
            hostname: 'a.klaviyo.com',
            path: endpoint,
            method: method,
            headers: {
                'Authorization': `Klaviyo-API-Key ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'revision': '2024-10-15'
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                try {
                    const parsed = responseData ? JSON.parse(responseData) : {};
                    
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({
                            success: true,
                            data: parsed,
                            statusCode: res.statusCode
                        });
                    } else {
                        resolve({
                            success: false,
                            error: parsed.errors ? parsed.errors[0].detail : `HTTP ${res.statusCode}`,
                            statusCode: res.statusCode,
                            data: parsed
                        });
                    }
                } catch (parseError) {
                    resolve({
                        success: false,
                        error: `Parse error: ${parseError.message}`,
                        statusCode: res.statusCode,
                        rawResponse: responseData
                    });
                }
            });
        });

        req.on('error', (error) => {
            resolve({
                success: false,
                error: `Request error: ${error.message}`
            });
        });

        req.write(postData);
        req.end();
    });
}

// Helper function to determine price range category
function getPriceRange(price) {
    const p = parseFloat(price);
    if (p <= 400) return 'budget';
    if (p <= 800) return 'mid-range';
    if (p <= 1500) return 'premium';
    return 'luxury';
}

// Helper function to determine destination region
function getDestinationRegion(destination) {
    const dest = destination.toLowerCase();
    
    // Latin America
    if (dest.includes('dominicana') || dest.includes('colombia') || dest.includes('méxico') || 
        dest.includes('mexico') || dest.includes('argentina') || dest.includes('perú') ||
        dest.includes('peru') || dest.includes('ecuador') || dest.includes('brasil') ||
        dest.includes('brazil') || dest.includes('chile') || dest.includes('venezuela') ||
        dest.includes('guatemala') || dest.includes('costa rica') || dest.includes('panamá') ||
        dest.includes('panama') || dest.includes('cuba') || dest.includes('puerto rico')) {
        return 'latin_america';
    }
    
    // Europe
    if (dest.includes('españa') || dest.includes('spain') || dest.includes('francia') ||
        dest.includes('france') || dest.includes('parís') || dest.includes('paris') ||
        dest.includes('londres') || dest.includes('london') || dest.includes('italia') ||
        dest.includes('italy') || dest.includes('roma') || dest.includes('rome') ||
        dest.includes('grecia') || dest.includes('greece') || dest.includes('turquía') ||
        dest.includes('turkey')) {
        return 'europe';
    }
    
    // Asia
    if (dest.includes('japón') || dest.includes('japan') || dest.includes('tokio') ||
        dest.includes('tokyo') || dest.includes('china') || dest.includes('india') ||
        dest.includes('tailandia') || dest.includes('thailand') || dest.includes('singapur') ||
        dest.includes('singapore') || dest.includes('corea') || dest.includes('korea') ||
        dest.includes('filipinas') || dest.includes('philippines')) {
        return 'asia';
    }
    
    // Middle East & Africa
    if (dest.includes('dubai') || dest.includes('egipto') || dest.includes('egypt') ||
        dest.includes('marruecos') || dest.includes('morocco') || dest.includes('sudáfrica') ||
        dest.includes('south africa') || dest.includes('nigeria')) {
        return 'middle_east_africa';
    }
    
    // Oceania
    if (dest.includes('australia') || dest.includes('nueva zelanda') || dest.includes('new zealand')) {
        return 'oceania';
    }
    
    return 'other';
}
