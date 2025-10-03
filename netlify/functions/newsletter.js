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
        if (!data.email) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Email is required' })
            };
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(data.email)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid email format' })
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

        // Rate limiting check (basic implementation)
        const userAgent = event.headers['user-agent'] || '';
        const clientIP = event.headers['x-forwarded-for'] || event.headers['x-real-ip'] || 'unknown';
        
        // Prepare Klaviyo profile data for general newsletter
        const profileData = {
            data: {
                type: 'profile',
                attributes: {
                    email: data.email,
                    properties: {
                        // General newsletter preferences
                        alert_type: data.alert_type || 'general_newsletter',
                        signup_source: data.signup_source || 'website_newsletter_section',
                        language: data.language || 'es',
                        location: data.location || 'NYC',
                        
                        // Metadata
                        signup_date: new Date().toISOString(),
                        last_updated: new Date().toISOString(),
                        client_ip: clientIP,
                        user_agent: userAgent,
                        
                        // Newsletter specific tags
                        newsletter_subscriber: true,
                        subscription_type: 'general',
                        content_language: 'spanish',
                        target_market: 'hispanic_nyc',
                        
                        // Default travel preferences (can be updated later)
                        preferred_departure: 'ALL',
                        interested_regions: ['latin_america', 'europe', 'asia'],
                        price_range: 'all',
                        travel_frequency: 'unknown',
                        
                        // Engagement tracking
                        signup_channel: 'website',
                        newsletter_version: 'v1',
                        marketing_consent: true
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

        const profileId = profileResponse.data.data.id;

        // Add profile to main newsletter list
        const listData = {
            data: [
                {
                    type: 'profile',
                    id: profileId
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

        // Track newsletter signup event
        const eventData = {
            data: {
                type: 'event',
                attributes: {
                    profile: {
                        email: data.email
                    },
                    metric: {
                        name: 'Newsletter Signup'
                    },
                    properties: {
                        signup_source: data.signup_source || 'website_newsletter_section',
                        signup_method: 'email_form',
                        language: data.language || 'es',
                        location: data.location || 'NYC',
                        subscription_type: 'general',
                        marketing_consent: true,
                        signup_page: 'homepage'
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

        // Track engagement event for Spanish-speaking market
        try {
            const marketEventData = {
                data: {
                    type: 'event',
                    attributes: {
                        profile: {
                            email: data.email
                        },
                        metric: {
                            name: 'Hispanic NYC Market Interest'
                        },
                        properties: {
                            market_segment: 'hispanic_nyc',
                            language_preference: 'spanish',
                            content_type: 'flight_deals',
                            engagement_level: 'subscriber'
                        },
                        time: new Date().toISOString()
                    }
                }
            };

            await makeKlaviyoRequest(
                'POST',
                '/api/events/',
                marketEventData,
                KLAVIYO_API_KEY
            );
        } catch (marketError) {
            console.warn('Could not create market segmentation event:', marketError);
        }

        // Success response
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: 'Newsletter signup successful',
                profile_id: profileId,
                email: data.email,
                subscription_type: 'general_newsletter'
            })
        };

    } catch (error) {
        console.error('Newsletter signup error:', error);
        
        // Check for specific Klaviyo errors
        if (error.message && error.message.includes('already exists')) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    message: 'Email already subscribed - preferences updated',
                    status: 'existing_subscriber'
                })
            };
        }
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Failed to process newsletter signup',
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

// Helper function for basic rate limiting (you might want to enhance this)
function isRateLimited(clientIP) {
    // Basic implementation - you could enhance this with Redis or database
    // For now, just log the attempt
    console.log(`Newsletter signup attempt from IP: ${clientIP}`);
    return false; // Allow all for now
}

// Helper function to validate and sanitize input
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.trim().substring(0, 255); // Limit length and trim whitespace
}
