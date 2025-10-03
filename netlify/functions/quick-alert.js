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
        if (!data.email || !data.destination || !data.target_price) {
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

        // Prepare Klaviyo profile data with quick alert defaults
        const profileData = {
            data: {
                type: 'profile',
                attributes: {
                    email: data.email,
                    properties: {
                        // Quick alert preferences (using smart defaults)
                        destination: data.destination,
                        departure_airport: data.departure_airport || 'ALL',
                        timeframe: data.timeframe || 'flexible',
                        travel_class: data.travel_class || 'economy',
                        target_price: parseFloat(data.target_price),
                        
                        // Alert settings
                        alert_type: data.alert_type || 'quick_alert',
                        signup_source: data.signup_source || 'website_destination_card',
                        language: data.language || 'es',
                        location: data.location || 'NYC',
                        
                        // Metadata
                        signup_date: new Date().toISOString(),
                        last_updated: new Date().toISOString(),
                        
                        // Quick alert specific tags
                        has_quick_alert: true,
                        quick_alert_destination: getDestinationCode(data.destination),
                        preferred_departure: data.departure_airport || 'ALL',
                        price_range: getPriceRange(data.target_price),
                        destination_region: getDestinationRegion(data.destination),
                        
                        // Popular destination tracking
                        popular_destination: true,
                        destination_popularity: getDestinationPopularity(data.destination)
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

        // Add profile to main list
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

        // Track quick alert event
        const eventData = {
            data: {
                type: 'event',
                attributes: {
                    profile: {
                        email: data.email
                    },
                    metric: {
                        name: 'Quick Flight Alert Created'
                    },
                    properties: {
                        destination: data.destination,
                        target_price: parseFloat(data.target_price),
                        destination_code: getDestinationCode(data.destination),
                        destination_region: getDestinationRegion(data.destination),
                        signup_method: 'destination_card_click',
                        is_popular_destination: true
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

        // Try to create destination-specific segment/tag
        try {
            const segmentEventData = {
                data: {
                    type: 'event',
                    attributes: {
                        profile: {
                            email: data.email
                        },
                        metric: {
                            name: `Interest: ${data.destination}`
                        },
                        properties: {
                            destination: data.destination,
                            interest_level: 'high',
                            source: 'quick_alert'
                        },
                        time: new Date().toISOString()
                    }
                }
            };

            await makeKlaviyoRequest(
                'POST',
                '/api/events/',
                segmentEventData,
                KLAVIYO_API_KEY
            );
        } catch (segmentError) {
            console.warn('Could not create destination segment event:', segmentError);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: 'Quick alert created successfully',
                profile_id: profileResponse.data.data.id,
                destination: data.destination,
                target_price: data.target_price
            })
        };

    } catch (error) {
        console.error('Quick alert error:', error);
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Failed to create quick alert',
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

// Helper function to get destination code for segmentation
function getDestinationCode(destination) {
    const dest = destination.toLowerCase();
    
    if (dest.includes('dominicana')) return 'DOM_REP';
    if (dest.includes('colombia')) return 'COLOMBIA';
    if (dest.includes('méxico') || dest.includes('mexico')) return 'MEXICO';
    if (dest.includes('parís') || dest.includes('paris')) return 'PARIS';
    if (dest.includes('londres') || dest.includes('london')) return 'LONDON';
    if (dest.includes('tokio') || dest.includes('tokyo')) return 'TOKYO';
    if (dest.includes('españa') || dest.includes('spain')) return 'SPAIN';
    if (dest.includes('argentina')) return 'ARGENTINA';
    if (dest.includes('perú') || dest.includes('peru')) return 'PERU';
    if (dest.includes('ecuador')) return 'ECUADOR';
    if (dest.includes('brasil') || dest.includes('brazil')) return 'BRAZIL';
    if (dest.includes('chile')) return 'CHILE';
    
    return 'OTHER';
}

// Helper function to determine destination popularity tier
function getDestinationPopularity(destination) {
    const dest = destination.toLowerCase();
    
    // Tier 1: Most popular Hispanic destinations
    if (dest.includes('dominicana') || dest.includes('méxico') || dest.includes('mexico') || 
        dest.includes('colombia') || dest.includes('españa') || dest.includes('spain')) {
        return 'tier1_high';
    }
    
    // Tier 2: Popular international destinations
    if (dest.includes('parís') || dest.includes('paris') || dest.includes('londres') || 
        dest.includes('london') || dest.includes('italia') || dest.includes('italy')) {
        return 'tier2_medium';
    }
    
    // Tier 3: Exotic/aspirational destinations
    if (dest.includes('tokio') || dest.includes('tokyo') || dest.includes('dubai') ||
        dest.includes('australia') || dest.includes('tailandia') || dest.includes('thailand')) {
        return 'tier3_aspirational';
    }
    
    return 'tier2_medium';
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
        dest.includes('italy') || dest.includes('roma') || dest.includes('rome')) {
        return 'europe';
    }
    
    // Asia
    if (dest.includes('japón') || dest.includes('japan') || dest.includes('tokio') ||
        dest.includes('tokyo') || dest.includes('china') || dest.includes('india')) {
        return 'asia';
    }
    
    return 'other';
}
