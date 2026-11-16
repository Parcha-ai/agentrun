# Seed /sdcard/Download with the task's fifteen files: four bid_ files dated as the run's pick says, and eleven others.
# Files that were there under these names (and any bid_ file) are moved aside once, into a hidden folder on the same
# storage (a retried setup keeps the first copy), and teardown puts them back.
D=/sdcard/Download
S=/sdcard/.computer-bench-{{nonce}}
OTHERS="ai_research_paper.pdf machine_learning_notes.txt data_analysis_report.doc chatbot_training_data.txt computer_vision_project.pdf nlp_processing_guide.doc ai_ethics_discussion.txt deep_learning_tutorial.pdf ai_deployment_strategy.doc recommendation_system.txt ai_performance_metrics.pdf"
mkdir -p $D $S/stash || exit 1
if [ ! -e $S/stashed ]; then
	for f in $D/bid_*; do if [ -e "$f" ]; then mv "$f" $S/stash/ || exit 1; fi; done
	for f in $OTHERS; do if [ -e "$D/$f" ]; then mv "$D/$f" $S/stash/ || exit 1; fi; done
	touch $S/stashed
fi
rm -f $D/bid_*
cat > $D/bid_restaurant_proposal.txt <<'EOF'
Restaurant Menu Bid Proposal

Proposal ID: BID-2024-001
Date: November 1, 2024

Dear Client,

We are pleased to submit our bid for your restaurant menu printing services.

MENU ITEMS INCLUDED:
- Appetizers Section (10 items)
- Main Course Section (25 items)
- Desserts Section (12 items)
- Beverages Section (15 items)

PRINTING SPECIFICATIONS:
- Full color printing on premium paper
- Laminated finish for durability
- Custom layout and design
- 100 copies per order

PRICING:
Total Bid Amount: $2,500
Delivery: 2 weeks

Thank you for considering our proposal.

Best regards,
Menu Printing Services
EOF
cat > $D/bid_catering_menu_2024.doc <<'EOF'
Catering Menu Bid

Bid Reference: BID-CAT-2024
Submitted: October 28, 2024

CATERING MENU PACKAGE

BREAKFAST MENU:
- Continental breakfast buffet
- Fresh fruit platter
- Pastries and croissants
- Coffee and tea service

LUNCH MENU:
- Choice of 3 entrees
- Salad bar
- Soup of the day
- Dessert selection

DINNER MENU:
- Appetizer course
- Main course (beef, chicken, or vegetarian)
- Side dishes
- Dessert and coffee

SERVICE DETAILS:
- Full service staff included
- Table setup and cleanup
- Serving utensils and chafing dishes

BID AMOUNT: $45 per person
Minimum order: 50 guests

Valid for 30 days from submission.
EOF
cat > $D/bid_menu_design_contract.pdf <<'EOF'
BID FOR MENU DESIGN SERVICES

Bid Number: MD-2024-055
Date: October 15, 2024

PROJECT SCOPE:
Design and development of restaurant menu

DELIVERABLES:
1. Menu concept and theme design
2. Food photography styling
3. Layout and typography
4. Digital and print-ready formats

MENU SECTIONS TO DESIGN:
- Appetizers and Starters
- Soups and Salads
- Main Dishes
- Chef's Specials
- Desserts
- Wine and Cocktail List

TIMELINE:
- Initial concepts: 1 week
- Revisions: 2 weeks
- Final delivery: 3 weeks total

PRICING BREAKDOWN:
Design fees: $3,000
Photography: $1,500
Revisions (up to 3): Included
Total Bid: $4,500

Terms: 50% deposit, 50% on completion
EOF
cat > $D/bid_food_supplier_quote.txt <<'EOF'
Food Supplier Bid Quotation

Bid ID: FS-2024-Q3-089
Quotation Date: September 30, 2024

MENU INGREDIENTS SUPPLY BID

Fresh Produce:
- Seasonal vegetables (daily delivery)
- Fresh fruits
- Herbs and greens

Proteins:
- Premium beef cuts
- Free-range chicken
- Fresh seafood
- Plant-based alternatives

Dairy Products:
- Artisan cheeses
- Fresh cream and butter
- Specialty yogurts

Dry Goods:
- Pasta varieties
- Rice and grains
- Specialty flours
- Spices and seasonings

DELIVERY SCHEDULE:
- Monday, Wednesday, Friday
- Emergency orders available
- Temperature-controlled transport

MONTHLY BID TOTAL: $15,000
(Based on estimated menu requirements)

Payment Terms: Net 30 days
Contract Period: 12 months
EOF
cat > $D/ai_research_paper.pdf <<'EOF'
AI Research: Neural Network Optimization

Abstract: This paper explores novel approaches to optimizing
deep neural networks for improved performance and efficiency.

Keywords: artificial intelligence, machine learning, optimization
EOF
cat > $D/machine_learning_notes.txt <<'EOF'
Machine Learning Study Notes

Chapter 1: Introduction to AI
- Definition of artificial intelligence
- History and evolution
- Current applications

Chapter 2: Neural Networks
- Perceptrons
- Backpropagation
- Deep learning architectures
EOF
cat > $D/data_analysis_report.doc <<'EOF'
AI-Powered Data Analysis Report

Executive Summary:
Our AI system analyzed 1 million data points to identify
patterns and trends in customer behavior.

Key Findings:
- Machine learning accuracy: 94%
- Processing time reduced by 60%
- Actionable insights generated
EOF
cat > $D/chatbot_training_data.txt <<'EOF'
Chatbot AI Training Dataset

Sample conversations for training conversational AI:
- Customer service queries
- Technical support dialogues
- General information requests

Training examples: 50,000 conversations
Language models: GPT-based architecture
EOF
cat > $D/computer_vision_project.pdf <<'EOF'
Computer Vision AI Project

Project Title: Image Recognition System

Technology Stack:
- Convolutional Neural Networks (CNN)
- TensorFlow and PyTorch
- OpenCV for preprocessing

Applications:
- Object detection
- Face recognition
- Scene understanding
EOF
cat > $D/nlp_processing_guide.doc <<'EOF'
Natural Language Processing Guide

AI-based text analysis and understanding:

1. Tokenization and preprocessing
2. Named Entity Recognition (NER)
3. Sentiment analysis
4. Text classification
5. Language generation

Tools: spaCy, NLTK, Transformers
EOF
cat > $D/ai_ethics_discussion.txt <<'EOF'
AI Ethics and Responsible AI

Discussion Topics:
- Bias in machine learning models
- Privacy concerns in AI systems
- Transparency and explainability
- AI safety and alignment
- Societal impact of automation
EOF
cat > $D/deep_learning_tutorial.pdf <<'EOF'
Deep Learning Tutorial

Introduction to Deep Neural Networks

Topics Covered:
- Architecture design
- Activation functions
- Optimization algorithms
- Regularization techniques
- Transfer learning

Frameworks: TensorFlow, Keras, PyTorch
EOF
cat > $D/ai_deployment_strategy.doc <<'EOF'
AI Model Deployment Strategy

Production Deployment Plan:

1. Model Training and Validation
2. API Development
3. Containerization (Docker)
4. Cloud Infrastructure Setup
5. Monitoring and Maintenance

Technologies: Kubernetes, MLOps, CI/CD
EOF
cat > $D/recommendation_system.txt <<'EOF'
AI Recommendation System

Collaborative Filtering Algorithm

Features:
- User-based recommendations
- Item-based filtering
- Matrix factorization
- Neural collaborative filtering

Use cases: e-commerce, streaming, content
EOF
cat > $D/ai_performance_metrics.pdf <<'EOF'
AI Model Performance Metrics

Evaluation Metrics:
- Accuracy, Precision, Recall
- F1 Score
- ROC-AUC
- Mean Squared Error (MSE)
- Confusion Matrix Analysis

Benchmarking results and comparisons.
EOF
# Dates: the bid files' come from the pick; the others' are fixed, between and around them.
touch -t {{o.pt}} $D/bid_restaurant_proposal.txt || exit 1
touch -t {{o.ct}} $D/bid_catering_menu_2024.doc || exit 1
touch -t {{o.dt}} $D/bid_menu_design_contract.pdf || exit 1
touch -t {{o.st}} $D/bid_food_supplier_quote.txt || exit 1
touch -t 202602250900 $D/ai_research_paper.pdf || exit 1
touch -t 202603051130 $D/machine_learning_notes.txt || exit 1
touch -t 202603121000 $D/data_analysis_report.doc || exit 1
touch -t 202603151545 $D/chatbot_training_data.txt || exit 1
touch -t 202603191210 $D/computer_vision_project.pdf || exit 1
touch -t 202603210840 $D/nlp_processing_guide.doc || exit 1
touch -t 202603231705 $D/ai_ethics_discussion.txt || exit 1
touch -t 202603250915 $D/deep_learning_tutorial.pdf || exit 1
touch -t 202603261400 $D/ai_deployment_strategy.doc || exit 1
touch -t 202603071020 $D/recommendation_system.txt || exit 1
touch -t 202603131330 $D/ai_performance_metrics.pdf || exit 1
# Ask the media scanner to read each file again, so file managers that list Download through MediaStore show these dates.
for f in $D/bid_* $OTHERS; do am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$D/${f##*/}" > /dev/null 2>&1; done
true
