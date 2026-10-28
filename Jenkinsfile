// Daily TractorJunction vs VMS compare (Jenkins counterpart of
// .github/workflows/daily-compare.yml).
//
// Every secret is a Jenkins "Secret text" credential whose ID matches the
// variable name below. Nothing sensitive lives in this file (the repo is public).
pipeline {
    agent any

    triggers {
        // Must finish before 10:00 IST.
        cron('TZ=Asia/Kolkata\n47 8 * * *')
    }

    options {
        timeout(time: 90, unit: 'MINUTES')
        disableConcurrentBuilds()
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    environment {
        VMS_API_BASE        = credentials('VMS_API_BASE')
        PROD_VMS_TOKEN      = credentials('PROD_VMS_TOKEN')
        ZOHO_ACCOUNTS_DC    = credentials('ZOHO_ACCOUNTS_DC')
        CLIQ_API_BASE       = credentials('CLIQ_API_BASE')
        CLIQ_CLIENT_ID      = credentials('CLIQ_CLIENT_ID')
        CLIQ_CLIENT_SECRET  = credentials('CLIQ_CLIENT_SECRET')
        CLIQ_REFRESH_TOKEN  = credentials('CLIQ_REFRESH_TOKEN')
        ZOHO_CLIQ_CHANNEL   = credentials('ZOHO_CLIQ_CHANNEL')
        SHEET_ID            = credentials('SHEET_ID')
        SHEET_WEBAPP_URL    = credentials('SHEET_WEBAPP_URL')
        SHEET_WEBAPP_SECRET = credentials('SHEET_WEBAPP_SECRET')
    }

    stages {
        stage('Install dependencies') {
            steps {
                sh 'node --version'
                sh 'npm ci --ignore-scripts'
            }
        }

        // The TJ DB is office-network only, so the location map (exported with
        // npm run location:export) comes from a credential instead.
        stage('Restore location map') {
            steps {
                withCredentials([string(credentialsId: 'LOCATION_MAP_GZ_B64', variable: 'LOCATION_MAP_GZ_B64')]) {
                    sh 'printf "%s" "$LOCATION_MAP_GZ_B64" | base64 -d | gunzip > data/location-map.json'
                }
            }
        }

        stage('Warn in Cliq if the VMS token expires within 3 days') {
            steps {
                catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE') {
                    sh '''
                        node --input-type=module -e "
                          const t = (process.env.PROD_VMS_TOKEN || '').replace(/^Bearer\\s+/i, '');
                          const exp = JSON.parse(Buffer.from(t.split('.')[1] || 'e30', 'base64url').toString()).exp;
                          const days = exp ? (exp * 1000 - Date.now()) / 86400000 : Infinity;
                          if (days < 3) {
                            const { notify } = await import('./auth/zoho-cliq.js');
                            await notify('⚠️ VMS token for the daily TractorJunction vs VMS compare ' + (days <= 0 ? 'has EXPIRED' : 'expires in ' + days.toFixed(1) + ' days') + ' — update the PROD_VMS_TOKEN Jenkins credential.');
                          }
                        "
                    '''
                }
            }
        }

        // Live scan of the site + VMS, then replaces the Google Sheet tabs and
        // posts the summary to Cliq. Output files hold VMS lead data, so they are
        // never archived as build artifacts.
        stage('Run compare, update sheet, post to Cliq') {
            steps {
                sh 'npm run daily:tractor-vs-vms'
            }
        }
    }

    post {
        failure {
            sh 'node auth/zoho-cliq.js notify "❌ Daily TractorJunction vs VMS compare failed — see ${BUILD_URL}"'
        }
        always {
            // Drop VMS lead data and the restored location map from the agent.
            sh 'rm -rf output data/location-map.json'
        }
    }
}
