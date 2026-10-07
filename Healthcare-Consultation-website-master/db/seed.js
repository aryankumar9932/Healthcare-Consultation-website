// Starter catalogue. Used by both the JSON and PostgreSQL stores.
const seed = {
  departments: [
    { id: 1, title: "Cardiology", description: "Expert care for heart and blood-vessel conditions.", image: "images/5fc6c72f4cd54.jpg" },
    { id: 2, title: "Gynecology", description: "Compassionate care for women's health at every stage.", image: "images/5fc6c31dcc11c.jpg" },
    { id: 3, title: "Neurology", description: "Diagnosis and treatment for the nervous system.", image: "images/5fc6c6e3193a5.png" },
    { id: 4, title: "Medicine", description: "Everyday primary care, prevention, and treatment.", image: "images/5fc6c797d059d.jpg" },
    { id: 5, title: "Dentistry", description: "Modern preventive and restorative dental care.", image: "images/5fc6c7e01b6be.jpg" },
    { id: 6, title: "Orthopedics", description: "Specialist care for bones, joints, and movement.", image: "images/5fe127a361f55.jpg" }
  ],
  doctors: [
    { id: 1, departmentId: 2, name: "Dr. Halima", specialty: "Gynecologist", bio: "Experienced women's health specialist.", fee: 650, image: "images/5ff394a115cbe.jpg", schedule: ["Monday 10:00 - 17:00", "Wednesday 10:00 - 17:00"] },
    { id: 2, departmentId: 1, name: "Dr. Johny", specialty: "Cardiologist", bio: "Focused on preventive and interventional heart care.", fee: 400, image: "images/5ff4aebc6fe31.jpg", schedule: ["Sunday 10:00 - 17:00", "Wednesday 11:00 - 18:00"] },
    { id: 3, departmentId: 2, name: "Dr. Sansa", specialty: "Gynecologist", bio: "Patient-first care for every family.", fee: 650, image: "images/5ff4aed5e8e21.jpg", schedule: ["Monday 10:00 - 17:00", "Wednesday 11:00 - 18:00"] },
    { id: 4, departmentId: 3, name: "Dr. John", specialty: "Neurologist", bio: "Helping patients understand and manage neurological health.", fee: 450, image: "images/5ff4aef3c8c25.jpg", schedule: ["Sunday 10:00 - 14:30", "Wednesday 11:00 - 18:00"] },
    { id: 5, departmentId: 4, name: "Dr. Lue", specialty: "Physician", bio: "Comprehensive primary and preventive care.", fee: 400, image: "images/5ff4af1bed6be.jpg", schedule: ["Sunday 10:00 - 17:00", "Monday 11:00 - 18:00"] },
    { id: 6, departmentId: 5, name: "Dr. Kaung", specialty: "Dentist", bio: "Comfortable, modern dental treatment.", fee: 450, image: "images/5ff4b00c9c319.jpg", schedule: ["Monday 10:00 - 17:00", "Wednesday 11:00 - 18:00"] },
    { id: 7, departmentId: 6, name: "Dr. Tomas", specialty: "Orthopedist", bio: "Restoring movement and quality of life.", fee: 650, image: "images/5ff4b029292e4.jpg", schedule: ["Sunday 10:00 - 14:30", "Tuesday 11:00 - 18:00"] }
  ],
  products: [
    { id: 1, name: "Sugatrol 100mg 10pcs", description: "Acarbose 100mg - Pacific Pharmaceuticals Ltd.", price: 240, image: "images/5fc6e8091e91d.jpg" },
    { id: 2, name: "Napa 500mg", description: "For temporary relief of headache and minor pain.", price: 50, image: "images/600e89f8523d9.jpg" }
  ],
  users: [],
  appointments: [],
  orders: [],
  clinics: [],
  prescriptions: [],
  medicalReports: []
};

module.exports = { seed };
